const fs = require('fs');
const workerpool = require('workerpool');
const process = require('process');
import * as $C from 'js-combinatorics';

import { Dex, BattleStreams, RandomPlayerAI, Teams, Species, PRNG, } from '@pkmn/sim';
import { sortBy, toID } from './util';

import * as pkmn from '@pkmn/sets';
import { Learnset } from '@pkmn/sim/build/sim/dex-species';

const gen: number = +process.env.GEN || 1;
const dex = Dex.forGen(gen);

var numToSpecies: Map<Number, Species> = new Map();

var genStart : number, genEnd: number;
switch (gen) {
    case 1: genStart = 1, genEnd = 151; break;
    case 2: genStart = 152, genEnd = 251; break;
    case 3: genStart = 252, genEnd = 386; break;
    case 4: genStart = 387, genEnd = 493; break;
    case 5: genStart = 494, genEnd = 649; break;
    default:
    case 6: genStart = 650, genEnd = 721; break;
}

for (const species of dex.species.all()) {
    if (!numToSpecies.has(species.num) && species.num > 0 && species.gen === gen && !species.forme) {
        numToSpecies.set(species.num, species);
    }
}

async function ComputeResult(teamA: string, teamB: string, seed: number, debug?: boolean): Promise<number> {
    const prng = new PRNG([seed, 2, 3, 4]);
    const battlestream = new BattleStreams.BattleStream();
    const streams = BattleStreams.getPlayerStreams(battlestream);
    const spec = { formatid: `gen${gen}customgame`, seed: prng.startingSeed };

    const p1 = new RandomPlayerAI(streams.p1, { seed: prng });
    const p2 = new RandomPlayerAI(streams.p2, { seed: prng });

    void p1.start();
    void p2.start();

    void streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify({ name: 'A', team: teamA })}
>player p2 ${JSON.stringify({ name: 'B', team: teamB })}`);

    for await (const chunk of streams.omniscient) {
        if (debug)
            console.log(chunk);
    }
    if (debug) {
        console.log(battlestream.battle?.inputLog);
    }
    let log = battlestream.battle!.log;
    for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].startsWith("|win|")) {
            return log[i].slice(5) === 'A' ? 2 : 0;
        }
        if (log[i] === "|tie") {
            return 1;
        }
    }
    return 1.0;
}

async function ScoreTeam(testTeam: string, testInd: number, otherTeams: string[], seedBase: number) {
    let score = 0;
    for (let i = 0; i < otherTeams.length; i++) {
        if (i == testInd) {
            continue;
        }
        score += await ComputeResult(testTeam, otherTeams[i], seedBase + i);
    }
    return score;
}

function getLevelLearnset(n: number): string[] {
    let species = numToSpecies.get(n)!;
    let learnSet: Learnset['learnset'] = JSON.parse(JSON.stringify(dex.species.getLearnset(species.id)!));
    if (!learnSet) {
        console.log(species);
        return [];
    }

    let prevo = species.prevo;
    while (prevo) {
        let ps = dex.species.get(prevo)!;
        let pls = dex.species.getLearnset(ps.id)!;

        for (const [moveid, sources] of Object.entries(pls)) {
            if (learnSet[moveid]) {
                learnSet[moveid] = learnSet[moveid].concat(sources);
            } else {
                learnSet[moveid] = sources.slice();
            }
        }

        prevo = ps.prevo;
    }

    learnSet = Object.fromEntries(Object.entries(learnSet).filter(x => {
        for (const source of x[1]) {
            if (source.startsWith(gen + 'L')) return true;
        }
        return false;
    }));

    // console.log(species.prevo, learnSet);

    let learnedLevel: { [key: string]: number } = {};
    for (const [move, v] of Object.entries(learnSet)) {
        for (const source of v) {
            if (source.startsWith(gen + 'L')) {
                learnedLevel[move] = +source.slice(2);
                break;
            }
        }
    }

    return sortBy(Object.keys(learnSet), move => -learnedLevel[move]);
}

function MakePackedTeam(num: Number, moves: string[]): string {
    let species = numToSpecies.get(num)!;

    let level = 100;
    const evs = gen <= 2 ? { hp: 255, atk: 255, def: 255, spa: 255, spd: 255, spe: 255 } : { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };
    const ivs = gen <= 2 ? { hp: 30, atk: 30, def: 30, spa: 30, spd: 30, spe: 30 } : { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

    const abilities = new Set(Object.values(species.abilities));
    const abilityData = Array.from(abilities).map(a => dex.abilities.get(a)).filter(a => a.gen === 3);
    sortBy(abilityData, abil => -abil.rating);
    let ability = gen <= 2 ? 'No Ability' : abilityData[0]?.name || 'No Ability';

    return Teams.pack([{
        name: species.baseSpecies,
        species: species.name,
        gender: species.gender,
        moves: moves,
        ability: ability,
        nature: 'Quirky',
        evs: evs,
        ivs: ivs,
        item: '',
        level: level,
    }]);
}

async function main() {
    const pool = workerpool.pool(__filename);

    const learnsets: string[][] = [];
    let movesets: string[][] = [];
    let mons: string[] = [];

    for (let n = genStart; n <= genEnd; n++) {
        let s = numToSpecies.get(n)!;
        let ls = getLevelLearnset(n);
        console.log(n, s.name, ls.length, ls.join(","));
        learnsets.push(ls);
        movesets.push(ls.slice(0, 4));
        mons.push(MakePackedTeam(n, ls.slice(0, 4)));
    }

    let fname = `opt${gen}.json`;
    try {
        let prevState = fs.readFileSync(fname);
        if (prevState) {
            prevState = JSON.parse(prevState);
            mons = prevState.mons;
            movesets = prevState.movesets;
        }
    } catch {}

    for (let loopcount = 0;; loopcount++) {
        for (let a = 0; a < mons.length; a++) {
            const n = a + genStart;
            const species = numToSpecies.get(n)!;
            const learnset = learnsets[a];

            let proms: [string[], Promise<number>][] = [];
            let attempt = (ms: string[]) => {
                proms.push([ms, pool.exec('ScoreTeam', [MakePackedTeam(n, ms), a, mons, loopcount * 1000])]);
            }

            attempt(movesets[a]);

            for (const c of new $C.Combination(learnset, 1)) {
                attempt(c);
            }
            for (const c of new $C.Combination(learnset, 2)) {
                attempt(c);
            }
            for (const c of new $C.Combination(learnset, 3)) {
                attempt(c);
            }
            for (const c of new $C.Combination(learnset, 4)) {
                attempt(c);
            }

            let initScore = await proms[0][1];
            let initMoves = proms[0][0];
            let bestScore = initScore;
            let bestMoves = initMoves;

            for (let i = 1; i < proms.length; i++) {
                let newScore = await proms[i][1];
                if (newScore > bestScore) {
                    bestScore = newScore;
                    bestMoves = proms[i][0];
                }
            }

            if (bestScore != initScore) {
                let initPerc = (initScore / mons.length / 2 * 100) | 0;
                let bestPerc = (bestScore / mons.length / 2 * 100) | 0;
                console.log(n, species.name, `${initPerc}% => ${bestPerc}%`, initMoves.join(','), '=>', bestMoves.join(','));
                movesets[a] = bestMoves;
                mons[a] = MakePackedTeam(n, bestMoves);
            }
        }
        console.log("LOOP", loopcount);
        fs.writeFileSync(fname, JSON.stringify({mons, movesets}));
    }

    pool.terminate();
}

if (workerpool.isMainThread) {
    main();
} else {
    workerpool.worker({
        ComputeResult,
        ScoreTeam,
    })
}

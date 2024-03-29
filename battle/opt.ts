const fs = require('fs');
const workerpool = require('workerpool');
const process = require('process');
import Database from 'better-sqlite3-int';
import * as $C from 'js-combinatorics';

import { Dex, BattleStreams, Teams, Species, PRNG, RandomPlayerAI, Battle, } from '@pkmn/sim';
import { sortBy } from './util';

import { Learnset } from '@pkmn/sim/build/sim/dex-species';

const gen: number = +process.env.GEN || 1;
const AI =  RandomPlayerAI;
const MULTIPROC = true;
const dex = Dex.forGen(gen);
let roundsPerMatch = +process.env.ROUNDS || 1;

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

const GENUPTO = !!process.env.ALL;

if (GENUPTO) {
    genStart = 1;
}

for (const species of dex.species.all()) {
    if (!numToSpecies.has(species.num) && species.num > 0 && (GENUPTO ? species.gen <= gen : species.gen === gen) && !species.forme) {
        numToSpecies.set(species.num, species);
    }
}

async function ComputeResult(teamA: string, teamB: string, seed: number, debug?: boolean): Promise<number> {
    const prng = new PRNG([seed, 2, 3, 4]);
    const battlestream = new BattleStreams.BattleStream();
    const streams = BattleStreams.getPlayerStreams(battlestream);
    const spec = { formatid: `gen${gen}customgame`, seed: prng.startingSeed };

    const p1 = new AI(streams.p1, { seed: prng });
    const p2 = new AI(streams.p2, { seed: prng });

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

class Result {
    id: number
    win: number
    tie: number
    lose: number

    constructor(id: number, win: number, tie: number, lose: number) {
        this.id = id;
        this.win = win;
        this.tie = tie;
        this.lose = lose;
    }

    get avg() {
        return (2 * this.win + this.tie) / (this.win + this.tie + this.lose);
    }
}

var cachedTids: {[key: string]: number};
var cachedResults: Map<string|number, Result> = new Map();

const db = new Database('battle.db', {timeout: 60_000});
function getDB() {
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA cache_size=-100000");

    db.exec("CREATE TABLE if not exists team(id integer primary key autoincrement, packed unique, species, level)");
    db.exec("CREATE TABLE if not exists results(id integer primary key autoincrement, gen, teama, teamb, win, lose, tie, unique(gen, teama, teamb))");

    if (!cachedTids) {
        cachedTids = Object.fromEntries(db.prepare("select packed, id from team").raw().iterate());
    }

    return db;
}

type BattleSpec = {
    teams: string[],
    matches: [ta: number, tb: number, seed: number, resid: number][],
};

type BattleRes = [resid: number, score: number][];

function MatchupKey(teamA: number, teamB: number) {
    return `${teamA},${teamB}`;
}

const _getResultQuery = db.prepare("select id, win, tie, lose from results where gen=? and teama=? and teamb=?").raw();

function GetResult(teamA: string|number, teamB: string|number) {
    if (typeof teamA === "string") {
        teamA = cachedTids[teamA];
    }
    if (typeof teamB === "string") {
        teamB = cachedTids[teamB];
    }
    const k = MatchupKey(teamA, teamB);
    const v = cachedResults.get(k);
    if (v !== undefined) {
        return v;
    }
    const row = _getResultQuery.get(gen, teamA, teamB);
    if (!row) {
        return;
    }
    const res = new Result(row[0], row[1], row[2], row[3]);
    cachedResults.set(k, res).set(row[0], res);
    return res;
}

function ComputeBattleSpec(testTeam: string|string[], testInd: number, otherTeams: string[], wantRounds: number, half?: boolean) {
    const db = getDB();

    function getTeamId(team: string, ind: number) {
        const s = numToSpecies.get(genStart + ind)!;
        //let tid = await db.get("select id from team where packed=?", team);
        let tid = cachedTids[team];
        if (!tid) {
            const res = db.prepare('insert into team(packed, species, level) values (?,?,?)').run(team, s.name, 100);
            tid = res.lastInsertRowid as number;
            cachedTids[team] = tid;
        }
        return tid;
    }

    const spec: BattleSpec = {
        teams: [],
        matches: [],
    }

    for (let i = 0; i < otherTeams.length; i++) {
        if (i == testInd) {
            continue;
        }
        if (half && i < testInd) {
            continue;
        }
        const curTeam = typeof testTeam === "string" ? testTeam : testTeam[i];
        const tid = getTeamId(curTeam, testInd);
        const otherTeamId = getTeamId(otherTeams[i], i);

        let neededBattles = wantRounds;
        let seed = 0;
        let matchupId = 0;
        let cres = GetResult(tid, otherTeamId);
        if (cres) {
            const tot = cres.lose+cres.tie+cres.win;
            matchupId = cres.id;
            neededBattles -= tot;
            seed = tot;
        } else {
            const row = db.prepare('insert into results(gen, teama, teamb, win, lose, tie) values(?, ?, ?, 0, 0, 0)').run(gen, tid, otherTeamId);
            matchupId = row.lastInsertRowid as number;
            const res = new Result(matchupId, 0, 0, 0);
            cachedResults.set(matchupId, res).set(MatchupKey(tid, otherTeamId), res);
        }
        if (neededBattles <= 0) {
            continue;
        }

        let curInd = spec.teams.indexOf(curTeam);
        if (curInd === -1) {
            curInd = spec.teams.length;
            spec.teams.push(curTeam);
        }
        const j = spec.teams.length;
        spec.teams.push(otherTeams[i]);
        for (let i = 0; i < neededBattles; i++, seed++) {
            spec.matches.push([curInd, j, seed, matchupId]);
        }
    }
    if (spec.matches.length === 0) {
        spec.teams = [];
    }
    return spec;
}

async function RunBattles(spec: BattleSpec) {
    const res: BattleRes = [];
    for (const match of spec.matches) {
        res.push([match[3], await ComputeResult(spec.teams[match[0]], spec.teams[match[1]], match[2])]);
    }
    return res;
}

const _commitStmt = db.prepare('update results set win=win+?, tie=tie+?, lose=lose+? where id=?');
function CommitBattles(results: BattleRes) {
    if (!results.length) { return; }
    const db = getDB();
    db.transaction(() => {
        for (const result of results) {
            const s = result[1];
            const w = +(s==2), t=+(s==1), l=+(s==0);
            _commitStmt.run(w, t, l, result[0]);
            const res = cachedResults.get(result[0])!;
            res.win += w;
            res.tie += t;
            res.lose += l;
        }
    })();
}

function RetrieveScores(movesets: string[][], ind: number, mons: string[]) {    const res: number[] = [];
    for (const ms of movesets) {
        const team = MakePackedTeam(ind + genStart, ms);
        let score = 0;
        for (let i = 0; i < mons.length; i++) {
            if (i == ind) continue;
            let row = GetResult(team, mons[i]);
            if (!row) continue;
            score += (2 * row.win + row.tie) / (row.win + row.tie + row.lose);
        }
        res.push(score);
    }
    return res;
}

function ComputeCover(movesets: string[][], ind: number, mons: string[], groupCount: number, groupSize: number) {
    let rows = movesets.slice();
    let cols = mons.slice(0, ind).concat(mons.slice(ind+1));
    console.assert(cols.length === mons.length-1);

    const sum = (x: number[]) => x.reduce((x, y) => x + y);

    let vals: number[][] = [];
    let valSums: number[] = [];

    function maxSumRows(inds: number[]) {
        if (inds.length === 1) {
            return valSums[inds[0]];
        }
        let out = 0;
        for (let i = 0; i < vals[0].length; i++) {
            let m = 0;
            for (const j of inds) {
                m = Math.max(m, vals[j][i]);
            }
            out += m;
        }
        return out;
    }

    function bestCombo(inds: number[], limit: number, branchLimit?: number): [number, number[]] {
        let opts: [number, number][] = [];

        let lastSum = inds.length > 0 ? valSums[inds[inds.length - 1]] : vals[0].length * 3;

        for (let i = 0; i < vals.length; i++) {
            if (inds.indexOf(i) !== -1) {
                continue;
            }
            if (valSums[i] > lastSum) {
                // enforce ordering of total winrate down
                continue;
            }
            inds.push(i);
            opts.push([i, maxSumRows(inds)]);
            inds.pop();
        }

        sortBy(opts, x => -x[1]);

        let bestInds: number[] = [];
        let bestSum = maxSumRows(inds);
        let lim = branchLimit || 4;

        if (inds.length >= 15) {
            // console.log("bestCombo", inds, opts.slice(0, 2), '=>', bestSum, bestInds);
            return [bestSum, bestInds];
        }

        const moves = new Set<string>();
        for (const ind of inds) {
            for (const m of rows[ind]) {
                moves.add(m);
            }
        }

        for (const o of opts) {
            let optlim = limit;
            for (const m of movesets[o[0]]) {
                if (!moves.has(m)) {
                    optlim--;
                }
            }
            if (optlim < 0) {
                continue;
            }
            lim--;

            inds.push(o[0]);
            const [curSum, curInds] = bestCombo(inds, optlim, branchLimit);
            inds.pop();
            if (curSum > bestSum) {
                bestSum = curSum;
                bestInds = [o[0]].concat(curInds);
            }
            if (lim == 0) break;
        }

        // console.log("bestCombo", inds, [...moves].join(','), opts.slice(0, 2), '=>', bestSum, bestInds);

        return [bestSum, bestInds];
    }

    let groupAlternates = {};
    let ret = [];
    for (let i = 0; i < groupCount; i++) {
        for (const row of rows) {
            const rowTeam = MakePackedTeam(ind + genStart, row);
            vals.push(cols.map(c => GetResult(rowTeam, c)!.avg));
        }
        vals.forEach((r, i) => { (r as any).name = rows[i]; } );
        valSums = vals.map(sum);

        const [combSum, combInds] = bestCombo([], 4, 4);

        if (combInds.length === 0) {
            // e.g. Abra losing at everything with Teleport
            combInds.push(0);
        }

        for (const ind of combInds) {
            (vals[ind] as any).star = true;
        }

        console.log(Math.round(maxSumRows(combInds) / vals[0].length * 500) / 10 + "%");
        // console.log(combInds);

        // rows.map((ms, i) => [vals[i].reduce((x,y)=>x+y), i]);
        vals = sortBy(vals, (a: any[]) => -a.reduce((x, y) => x + y) );
        for (let j = 0; j < vals.length; j++) {
            const val = vals[j];
            const sum = Math.round(val.reduce((x, y) => x + y) / val.length * 50);
            //const star = combInds.indexOf(j) === -1 ? "" : "* ";
            const star = (val as any).star ? "* " : "";
            if (!star) continue;
            // console.log((j + star + (val as any).name.join(",")).padEnd(50), (sum + "%").padStart(5), val.map(x =>'▁▂▃▄▅▆▇█'[Math.min((x* 7 / 2)|0, 7)]).join(""));
            console.log(((val as any).name.join(",")).padEnd(50), (sum + "%").padStart(5), val.map(x =>'▁▂▃▄▅▆▇█'[Math.min((x* 7 / 2)|0, 7)]).join(""));
        }

        return combInds;
        break;
    }
}


async function ScoreTeam(testTeam: string, testInd: number, otherTeams: string[], seedBase: number) {
    let score = 0;
    for (let i = 0; i < otherTeams.length; i++) {
        if (i == testInd) {
            continue;
        }
        for (let j = 0; j < roundsPerMatch; j++) {
            score += await ComputeResult(testTeam, otherTeams[i], seedBase + i + j * 100);
        }
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

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const pool = workerpool.pool(__filename);

    const learnsets: string[][] = [];
    let movesets: string[][] = [];
    let mainMons: string[] = [];
    let alternates: [number[], string[]][][] = [];

    for (let n = genStart; n <= genEnd; n++) {
        let s = numToSpecies.get(n)!;
        let ls = getLevelLearnset(n);
        process.env.SKIPMOVES || console.log(n, s.name, ls.length, ls.join(","));
        learnsets.push(ls);
        movesets.push(ls.slice(0, 4));
        mainMons.push(MakePackedTeam(n, ls.slice(0, 4)));
        alternates.push([]);
    }

    if (0) {
        for (let i = 0; ; i++) {
            let battles = ComputeBattleSpec(
                mainMons[0], 0,
                mainMons.slice(0, 20),
                //'Charmander|||NoAbility|flamethrower,slash,scratch|Quirky|255,255,255,255,255,255|N|30,30,30,30,30,30|||',
                //"Squirtle|||NoAbility|hydropump,tackle|Quirky|255,255,255,255,255,255|N|30,30,30,30,30,30|||",
                roundsPerMatch,
                );
            let res = await RunBattles(battles);
            CommitBattles(res);
            console.log(res);
            await sleep(1000);
            continue;
            await ComputeResult(
                mainMons[0], mainMons[1],
                //'Charmander|||NoAbility|flamethrower,slash,scratch|Quirky|255,255,255,255,255,255|N|30,30,30,30,30,30|||',
                //"Squirtle|||NoAbility|hydropump,tackle|Quirky|255,255,255,255,255,255|N|30,30,30,30,30,30|||",
                i, true);
            await sleep(1000);
        }
        return;
    }

    let fname = `opt${gen}.json`;
    if (GENUPTO) {
        fname = `opt${gen}all.json`;
    }
    try {
        let prevState = fs.readFileSync(fname);
        if (prevState) {
            prevState = JSON.parse(prevState);
            mainMons = prevState.mons;
            movesets = prevState.movesets;
            if (process.env.COVER) {
                alternates = prevState.alternates || alternates;
            }
        }
    } catch {
        try {
            if (GENUPTO) {
                mainMons = [];
                movesets = [];
                for (let g = 1; g <= gen; g++) {
                    let prevState = fs.readFileSync(`opt${g}.json`);
                    if (prevState) {
                        prevState = JSON.parse(prevState);
                        mainMons = mainMons.concat(prevState.mons);
                        movesets = movesets.concat(prevState.movesets);
                    }
                }
            }
        } catch {
            console.log("generate the gen individually first");
            process.exit(1);
        }
    }

    function makeOpponents(a: number) {
        const mons: string[] = [];
        for (let b = 0; b < movesets.length; b++) {
            let ms = movesets[b];
            if (alternates[b].length > 0) {
                ms = alternates[b][0][1];
                for (let i = 1; i < alternates[b].length; i++) {
                    if ((alternates[b][i][0]).indexOf(a + genStart) >= 0) {
                        ms = alternates[b][i][1];
                    }
                }
            }
            mons.push(MakePackedTeam(b + genStart, ms));
        }
        return mons;
    }

    function makeSelves(a: number) {
        const mons: string[] = [];
        if (alternates[a].length == 0) {
            return MakePackedTeam(a + genStart, movesets[a]);
        }
        const alts = alternates[a];
        for (let b = 0; b < movesets.length; b++) {
            let ms = alts[0][1];
            for (let i = 1; i < alts.length; i++) {
                if ((alts[i][0]).indexOf(b + genStart) >= 0) {
                    ms = alts[i][1];
                }
            }
            mons.push(MakePackedTeam(a + genStart, ms));
        }
        return mons;
    }


    let probeCount = 0;
    let proms: Promise<BattleRes>[] = [];

    async function commit() {
        // console.log("waiting for", proms.length);
        for (const prom of proms) {
            const res = await prom;
            probeCount += res.length;
            CommitBattles(res);
        }
        proms = [];
    }

    for (let loopcount = 0;; loopcount++) {
        for (let a = 0; a < movesets.length; a++) {
            cachedResults.clear(); // large map operations are very slow
            const n = a + genStart;
            const species = numToSpecies.get(n)!;
            const learnset = learnsets[a];

            let mons = makeOpponents(a);

            probeCount = 0;

            let msa: string[][] = [];
            let attempt = (ms: string[], rounds?: number, options?: {half?: boolean, split?: number}) => {
                const battles = ComputeBattleSpec(MakePackedTeam(n, ms), a, mons, rounds || roundsPerMatch, options?.half || false);
                msa.push(ms);

                if (battles.matches.length == 0) return;

                if (MULTIPROC) {
                    if (options?.split) {
                        const splitlen = Math.ceil(battles.matches.length / options.split);
                        for (let i = 0; i < battles.matches.length; i += splitlen) {
                            proms.push(pool.exec('RunBattles', [{teams: battles.teams, matches: battles.matches.slice(i, i + splitlen)}]));
                        }
                    } else {
                        proms.push(pool.exec('RunBattles', [battles]));
                    }
                } else {
                    proms.push(RunBattles(battles));
                }
            }

            // optimization: run the full move permutations against only 1/16th of
            // the full opponent roster, then run the top moves again to determine optimal
            let origmons = mons;
            mons = origmons.filter((_, i) => !(i % 16));

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

            await commit();

            let comboCount = msa.length;

            let initScore = (RetrieveScores([movesets[a]], a, mons))[0];
            let initMoves = movesets[a];

            let scoreMove: [number, string[]][] = [];

            function updateScores() {
                scoreMove = sortBy(RetrieveScores(msa, a, mons).map((v, i) => [v, msa[i]]), x => -x[0]);
            }

            updateScores();

            // now try the top contenders against the full opponent roster
            mons = origmons;

            // 1 round for the top 100 movesets
            for (let i = 0; i < scoreMove.length && i < 100 && scoreMove[i][0] >= initScore * .7; i++) {
                attempt(scoreMove[i][1], 1, {split: 8});
                msa.pop();
            }

            await commit();
            updateScores();

            // initScore can change with the extra sampling
            initScore = (RetrieveScores([movesets[a]], a, mons))[0];

            // 10 rounds for the top 20 movesets
            for (let i = 0; i < scoreMove.length && i < 20 && scoreMove[i][0] >= initScore * .9; i++) {
                attempt(scoreMove[i][1], 10, {split: 8});
                msa.pop();
            }

            await commit();
            updateScores();

            // initScore can change with the extra sampling
            initScore = (RetrieveScores([movesets[a]], a, mons))[0];
            let bestScore = scoreMove[0][0];
            let bestMoves = scoreMove[0][1];

            if (process.env.COVER) {
                const picks = (ComputeCover(msa, a, mons, 4, 10) || []).map(x => msa[x]);
                for (const pick of picks) {
                    attempt(pick, 10, {split: 8});
                    msa.pop();
                }
                await commit();

                // populate alternates by picking the moveset that maximizes score
                // for each given matchup
                const pt = picks.map(x => MakePackedTeam(a + genStart, x));

                let sel: typeof alternates[0] = alternates[a] = picks.map(x => [[], x]);

                for (let b = 0; b < mons.length; b++) {
                    if (b === a) continue;
                    let bi = 0, bs = 0;
                    for (let pi = 0; pi < pt.length; pi++) {
                        const row = GetResult(pt[pi], mons[b]);
                        if (!row) continue;
                        const avg = row.avg;
                        if (avg > bs) {
                            bi = pi;
                            bs = avg;
                        }
                    }
                    sel[bi][0].push(b + genStart);
                }

                sortBy(sel, x => -x[0].length);
                sel[0][0] = [];  // first alternate moveset is "default" and wins the most matches
            }

            if (process.env.FINAL) {
                attempt(bestMoves, 50, {half: true, split: 16});
                await commit();
            }

            const initPerc = (initScore / (mons.length * 2) * 100) | 0;
            if (JSON.stringify(bestMoves) !== JSON.stringify(initMoves)) {
                let bestPerc = (bestScore / (mons.length * 2) * 100) | 0;
                console.log(n, `${probeCount}B/${comboCount}C`, proms.length, species.name, `${initPerc}% => ${bestPerc}%`, initMoves.join(','), '=>', bestMoves.join(','));
                movesets[a] = bestMoves;
                mainMons[a] = MakePackedTeam(n, bestMoves);
            } else {
                console.log(n, `${probeCount}B/${comboCount}C`, proms.length, species.name, `${initPerc}%`, initMoves.join(','));
            }
        }
        fs.writeFileSync(fname, JSON.stringify({mons: mainMons, movesets, alternates, learnsets}));
        roundsPerMatch++;
        break;
        console.log("LOOP", loopcount);
    }

    // do a final round of computing multiple battles for all the specified matchups
    // this lets the graphing look nicer
    probeCount = 0;
    for (let a = 0; a < movesets.length; a++) {
        function attempt(selves: string|string[], mons: string[]) {
            const battles = ComputeBattleSpec(selves, a, mons, 100, true);

            if (battles.matches.length == 0) {
                return;
            }

            proms.push(MULTIPROC ? pool.exec('RunBattles', [battles]) : RunBattles(battles));
        }
        if (process.env.COVER) {
            const mons = makeOpponents(a);
            const selves = makeSelves(a);
            attempt(selves, mons);
        }
        attempt(MakePackedTeam(a + genStart, movesets[a]), mainMons);
    }
    await commit();
    console.log(`Final: ${probeCount}B`, proms.length);


    pool.terminate();
}

if (workerpool.isMainThread) {
    main();
} else {
    workerpool.worker({
        ComputeResult,
        ScoreTeam,
        RunBattles,
    })
}

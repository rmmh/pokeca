import {Dex, BattleStreams, RandomPlayerAI, Teams, Species, PRNG} from '@pkmn/sim';
import {sortBy} from './util';

import * as pkmn from '@pkmn/sets';

const dex = Dex.forGen(3);

var numToSpecies : Map<Number, Species> = new Map();

for (const species of dex.species.all()) {
  if (!numToSpecies.has(species.num))
    numToSpecies.set(species.num, species);
}

function MakeSimpleTeam(num: Number): pkmn.PokemonSet[] {
  let species = numToSpecies.get(num)!;

  // console.log(species);

  let learnSet = dex.species.getLearnset(species.id)!;
  learnSet = Object.fromEntries(Object.entries(learnSet).filter(x => {
    if (['batonpass'].indexOf(x[0]) !== -1) {
      // pointless moves in 1v1
      return false;
    }
    /*
    if (['explosion', 'destinybond', 'perishsong', 'batonpass'].indexOf(x[0]) !== -1) {
      // suicide moves are pointless in 1v1
      return false;
    }
    */
    for (const source of x[1]) {
      if (source.startsWith('3L')) return true;
    }
    return false;
  }));
  let learnedLevel: {[key: string]: number} = {};
  for (const [move, v] of Object.entries(learnSet)) {
    for (const source of v) {
      if (source.startsWith('3L')) {
        learnedLevel[move] = +source.slice(2);
      }
    }
  }
  // console.log(learnSet);
  const movePool = Object.keys(learnSet).slice();
  sortBy(movePool, move => -learnedLevel[move]);
  // console.log(movePool);
  const moves = new Set<string>(movePool.slice(0, 4));
  const evs = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };
  const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  let availableHP = 0;
  for (const setMoveid of movePool) {
    if (setMoveid.startsWith('hiddenpower')) availableHP++;
  }

  const abilities = new Set(Object.values(species.abilities));
  const abilityData = Array.from(abilities).map(a => dex.abilities.get(a)).filter(a => a.gen === 3);
  sortBy(abilityData, abil => -abil.rating);
  let ability = abilityData[0].name;

  return [{
    name: species.baseSpecies,
    species: species.name,
    gender: species.gender,
    moves: Array.from(moves),
    ability: ability,
    nature: 'Quirky',
    evs: evs,
    ivs: ivs,
    item: '',
    level: 100,
  }];
}

async function ComputeResult(pokeA: number, pokeB: number, seed: number, debug?: boolean) {
  const prng = new PRNG([seed,2,3,4]);
  const battlestream = new BattleStreams.BattleStream();
  const streams = BattleStreams.getPlayerStreams(battlestream);
  const spec = {formatid: 'gen3customgame', seed: prng.startingSeed};

  // Teams.setGeneratorFactory(TeamGenerators);
  //const p1spec = {name: 'Bot 1', team: Teams.pack(Teams.generate('gen7randombattle'))};
  //const p2spec = {name: 'Bot 2', team: Teams.pack(Teams.generate('gen7randombattle'))};
  const p1spec = {name: `${pokeA}`, team: Teams.pack(MakeSimpleTeam(pokeA))};
  const p2spec = {name: `${pokeB}`, team: Teams.pack(MakeSimpleTeam(pokeB))};

  const p1 = new RandomPlayerAI(streams.p1, {seed: prng});
  const p2 = new RandomPlayerAI(streams.p2, {seed: prng});

  void p1.start();
  void p2.start();

  void streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);

  for await (const chunk of streams.omniscient) {
    if (debug)
      console.log(chunk);
  }
  if (debug) {
    //console.log(battlestream.battle?.prngSeed);
    console.log(battlestream.battle?.inputLog);
  }
  let log = battlestream.battle!.log;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].startsWith("|win|")) {
      return +log[i].slice(5);
    }
    if (log[i] === "|tie") {
      return 0;
    }
  }
}

async function ComputeWinProbabilities() {
  for (let a = 1; a <= 151; a++) {
    for (let b = a + 1; b <= 151; b++) {
      let win = 0, lose = 0, tie = 0;
      for (let seed = 1; seed <= 100; seed++) {
        let res = await ComputeResult(a, b, seed);
        if (res === a) {
          win++;
        } else if (res === b) {
          lose++;
        } else {
          tie++;
        }
      }
      console.log(a, b, win, lose, tie);
      console.log(numToSpecies.get(a)?.name, "vs", numToSpecies.get(b)?.name, "=", `${win}% win${tie?", " + tie + "% tie":""}`)
    }
  }
}

//ComputeResult(1, 93, 1, true);
ComputeWinProbabilities();

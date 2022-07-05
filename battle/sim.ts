const fs = require('fs');

import {Dex, BattleStreams, RandomPlayerAI, Teams, Species, PRNG} from '@pkmn/sim';
import {sortBy} from './util';

import * as pkmn from '@pkmn/sets';

const gen = 2;
const dex = Dex.forGen(gen);

const sets = JSON.parse(fs.readFileSync('gen1.json')); // from https://pkmn.github.io/smogon/data/sets/gen1.json

var numToSpecies : Map<Number, Species> = new Map();

for (const species of dex.species.all()) {
  if (!numToSpecies.has(species.num))
    numToSpecies.set(species.num, species);
}

function getSmogMoves(n: string): Set<string> | undefined {
  let smogset = sets[n];
  if (!smogset) return;

  let moves: Set<string> = new Set();

  let cupOrder = sortBy(Object.keys(smogset).slice(), x => {
    return ["1v1", "lclevel100", "middlecup", "monotype", "nintendocup1997", "nintendocup1999", "nu", "ou", "petitcup", "pikacup", "pu", "stadiumou", "tradebacksou", "ubers", "u"].indexOf(x);
  });
  for (const cupname of cupOrder) {
    const cup = smogset[cupname];
    for (const buildname of Object.keys(cup)) {
      moves.clear();
      for (const move of cup[buildname].moves) {
        if (typeof move === "string") {
          moves.add(dex.moves.get(move).name);
        } else if (typeof move[0] === "string") {
          moves.add(dex.moves.get(move[0]).name);
        }
      }
      if (moves.has('Explosion') || moves.has('Self-Destruct')) {
        continue;
      }
      // console.log(cupname, buildname);
      return moves;
    }
  }
  return moves;
}

// MakeSimpleTeam is very simple: it makes a single level 100 pokemon
// of the given number with moves based on the last 4 moves available from
// level ups, maxed IVs/EVs, no items, and a neutral nature.
//
// This is nowhere near the optimal for each species, but it approximates
// what wild encounters look like, and is sufficient as a baseline.
function MakeSimpleTeam(num: Number): pkmn.PokemonSet[] {
  let species = numToSpecies.get(num)!;

  const levelScale: { [k: string]: number } = {
    Uber: 76,
    OU: 80,
    UUBL: 82,
    UU: 84,
    NUBL: 86,
    NU: 88,
    NFE: 90,
  };
  const customScale: { [k: string]: number } = {
    Ditto: 99, Unown: 99,
  };
  const tier = species.tier;
  const level = customScale[species.name] || levelScale[tier] || (species.nfe ? 90 : 80);

  // console.log(species);

  let learnSet = dex.species.getLearnset(species.id)!;
  learnSet = Object.fromEntries(Object.entries(learnSet).filter(x => {
    if (['batonpass'].indexOf(x[0]) !== -1) {
      // pointless moves in 1v1
      return false;
    }
    for (const source of x[1]) {
      if (source.startsWith(gen + 'L') && +source.slice(2) <= level) return true;
    }
    return false;
  }));
  let learnedLevel: {[key: string]: number} = {};
  for (const [move, v] of Object.entries(learnSet)) {
    for (const source of v) {
      if (source.startsWith(gen + 'L')) {
        learnedLevel[move] = +source.slice(2);
      }
    }
  }
  // console.log(learnSet);
  const movePool = Object.keys(learnSet).slice();
  sortBy(movePool, move => -learnedLevel[move]);
  // console.log(movePool);

  let moves = getSmogMoves(species.name);
  if (!moves) {
    moves = new Set();
    for (const move of movePool.slice(0, 4)) {
      moves.add(dex.moves.get(move).name);
    }
  }

  const evs = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };
  const ivs = gen <= 2 ? {hp: 30, atk: 30, def: 30, spa: 30, spd: 15, spe: 30} : { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  let availableHP = 0;
  for (const setMoveid of movePool) {
    if (setMoveid.startsWith('hiddenpower')) availableHP++;
  }

  const abilities = new Set(Object.values(species.abilities));
  const abilityData = Array.from(abilities).map(a => dex.abilities.get(a)).filter(a => a.gen === 3);
  sortBy(abilityData, abil => -abil.rating);
  let ability = abilityData[0].name;
  if (gen <= 2) {
    ability = '';
  }

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
    level: level,
  }];
}

for (let i = 1; i <= 151; i++) {
  let p = MakeSimpleTeam(i)[0];
  console.log(dex.species.get(p.name).num, p.species, "lvl" + p.level, p.moves.join(','));
}

async function ComputeResult(pokeA: number, pokeB: number, seed: number, debug?: boolean) {
  const prng = new PRNG([seed,2,3,4]);
  const battlestream = new BattleStreams.BattleStream();
  const streams = BattleStreams.getPlayerStreams(battlestream);
  const spec = {formatid: `gen${gen}customgame`, seed: prng.startingSeed};

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
      let pa = MakeSimpleTeam(a)[0], pb = MakeSimpleTeam(b)[0];
      console.log(pa.species, "vs", pb.species, "=", `${win}% win${tie ? ", " + tie + "% tie" : ""}`);
      console.log(a, b, win, lose, tie);
    }
  }
}

// ComputeResult(150, 151, 1, true);
ComputeWinProbabilities();

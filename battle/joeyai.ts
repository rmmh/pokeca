/**
 * Joey AI, just slightly smarter than  RandomPlayerAI.
 *
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * @license MIT
 */

import { Generations } from '@pkmn/data';
import { PRNG, PRNGSeed, AnyObject, BattleStreams, ModdedDex } from '@pkmn/sim';
import { ObjectReadWriteStream } from '@pkmn/streams';
import * as calc from '@smogon/calc';
import * as dex from '@pkmn/dex';

const gens = new Generations(dex.Dex);
let moveCache: {[key: string]: MoveResult} = {};

type MoveResult = ReturnType<typeof calc.calculate> & { accuracy?: number };

function MoveEffects(num: dex.GenerationNum, a: string, b: string, move: string): MoveResult {
	const k = a + b + move;
	const gen = gens.get(num);
	if (moveCache[k]) {
		return moveCache[k];
	}

	console.log(num, a, b, move);

	let res: ReturnType<typeof MoveEffects> = calc.calculate(
		gen,
		new calc.Pokemon(gen, a),
		new calc.Pokemon(gen, b),
		new calc.Move(gen, move)
	);

	const acc = gen.moves.get(move)?.accuracy;
	res.accuracy = acc === true ? 100 : acc;

	return moveCache[k] = res;
}

export function ClearMoveCache() {
	moveCache = {};
}

export class JoeyAI extends BattleStreams.BattlePlayer {
	protected readonly move: number;
	protected readonly mega: number;
    protected readonly prng: PRNG;
	protected gen: dex.GenerationNum;
	unhandledReq?: AnyObject;
	activePokemon: {[key: string]: string};

	constructor(
		playerStream: ObjectReadWriteStream<string>,
		options: {move?: number, mega?: number, seed?: PRNG | PRNGSeed | null, dex?: ModdedDex } = {},
		debug = false
	) {
		super(playerStream, debug);
		this.move = options.move || 1.0;
		this.mega = options.mega || 0;
		this.prng = options.seed && !Array.isArray(options.seed) ? options.seed : new PRNG(options.seed);
		this.gen = 1;
		this.activePokemon = {};
	}

	receive(chunk: string) {
		super.receive(chunk);
		if (this.unhandledReq && Object.keys(this.activePokemon).length > 0) {
			this.receiveRequest(this.unhandledReq);
			delete this.unhandledReq;
		}
	}

	receiveError(error: Error) {
		// If we made an unavailable choice we will receive a followup request to
		// allow us the opportunity to correct our decision.
		if (error.message.startsWith('[Unavailable choice]')) return;
		throw error;
	}

	receiveLine(line: string): void {
		const parts = line.slice(1).split('|');
		const cmd = parts[0];
		if (cmd === "gen") {
			this.gen = +parts[1] as calc.GenerationNum;
		} else if (cmd === "switch") {
			this.activePokemon[parts[1].slice(0, 2)] = parts[1].slice(5);
		}
		super.receiveLine(line);
	}

	receiveRequest(request: AnyObject) {
		if (Object.keys(this.activePokemon).length === 0) {
			// request comes before the rest of the state updates.
			// https://github.com/smogon/pokemon-showdown/issues/8546
			// this is irritating, but I'm punting fixing the underlying
			// bug until I need more precise state tracking.
			if (this.unhandledReq) {
				throw new Error("two reqs queued");
			}
			this.unhandledReq = request;
			return;
		}
		if (request.wait) {
			// wait request
			// do nothing
		} else if (request.forceSwitch) {
			// switch request
			const pokemon = request.side.pokemon;
			const chosen: number[] = [];
			const choices = request.forceSwitch.map((mustSwitch: AnyObject) => {
				if (!mustSwitch) return `pass`;

				const canSwitch = range(1, 6).filter(i => (
					pokemon[i - 1] &&
					// not active
					i > request.forceSwitch.length &&
					// not chosen for a simultaneous switch
					!chosen.includes(i) &&
					// not fainted
					!pokemon[i - 1].condition.endsWith(` fnt`)
				));

				if (!canSwitch.length) return `pass`;
				const target = this.chooseSwitch(
					request.active,
					canSwitch.map(slot => ({slot, pokemon: pokemon[slot - 1]}))
				);
				chosen.push(target);
				return `switch ${target}`;
			});

			this.choose(choices.join(`, `));
		} else if (request.active) {
			// move request
			let [canMegaEvo, canUltraBurst, canZMove, canDynamax] = [true, true, true, true];
			const pokemon = request.side.pokemon;
			const chosen: number[] = [];
			const choices = request.active.map((active: AnyObject, i: number) => {
				if (pokemon[i].condition.endsWith(` fnt`)) return `pass`;

				canMegaEvo = canMegaEvo && active.canMegaEvo;
				canUltraBurst = canUltraBurst && active.canUltraBurst;
				canZMove = canZMove && !!active.canZMove;
				canDynamax = canDynamax && !!active.canDynamax;

				// Determine whether we should change form if we do end up switching
				const change = (canMegaEvo || canUltraBurst || canDynamax) && this.prng.next() < this.mega;
				// If we've already dynamaxed or if we're planning on potentially dynamaxing
				// we need to use the maxMoves instead of our regular moves

				const useMaxMoves = (!active.canDynamax && active.maxMoves) || (change && canDynamax);
				const possibleMoves = useMaxMoves ? active.maxMoves.maxMoves : active.moves;

				let me = this.activePokemon[request.side.id];
				let other = this.activePokemon[request.side.id === 'p1' ? 'p2' : 'p1'] || 'Rattata';

				let canMove: {
					slot: number;
					move: any;
					target: any;
					zMove: boolean;
					effects?: MoveResult;
				}[] = range(1, possibleMoves.length).filter(j => (
					// not disabled
					!possibleMoves[j - 1].disabled
					// NOTE: we don't actually check for whether we have PP or not because the
					// simulator will mark the move as disabled if there is zero PP and there are
					// situations where we actually need to use a move with 0 PP (Gen 1 Wrap).
				)).map(j => ({
					slot: j,
					move: possibleMoves[j - 1].move,
					target: possibleMoves[j - 1].target,
					zMove: false,
				}));

				if (canZMove) {
					canMove.push(...range(1, active.canZMove.length)
						.filter(j => active.canZMove[j - 1])
						.map(j => ({
							slot: j,
							move: active.canZMove[j - 1].move,
							target: active.canZMove[j - 1].target,
							zMove: true,
						})));
				}

				if (canMove.length > 1) {
					for (const move of canMove) {
						if (move.target === "normal" || move.target === "allAdjacentFoes" || move.target === "allAdjacent"
							|| move.target === "randomNormal" || move.target === "any") {
							move.effects = MoveEffects(this.gen, me, other, move.move);
						} else if (move.target === "self") {
							move.effects = MoveEffects(this.gen, me, me, move.move);
						}
					}
				}

				// Filter out adjacentAlly moves if we have no allies left, unless they're our
				// only possible move options.
				const hasAlly = pokemon.length > 1 && !pokemon[i ^ 1].condition.endsWith(` fnt`);
				const filtered = canMove.filter(m => m.target !== `adjacentAlly` || hasAlly);
				canMove = filtered.length ? filtered : canMove;

				// Keep only the attack move with the highest expected damage.
				if (canMove.length > 1) {
					let bestMoveName = "", bestMoveDamage = 0;
					for (const move of canMove) {
						const cat = move.effects?.move.category;
						if (move.effects && (cat === "Physical" || cat === "Special")) {
							let median = 50;
							let dmg = move.effects.damage;
							if (typeof dmg === "number") {
								median = dmg;
							} else {
								dmg = dmg[dmg.length >> 1];
								if (typeof dmg === "number") {
									median = dmg;
								}
							}
							let exp = median * (move.effects.accuracy || 100);
							if (exp > bestMoveDamage) {
								bestMoveDamage = exp;
								bestMoveName = move.move;
							}
						}
					}
					if (bestMoveName) {
						canMove = canMove.filter(move => {
							const cat = move.effects?.move.category;
							if (move.effects && (cat === "Physical" || cat === "Special")) {
								if (move.move != bestMoveName) {
									return false;
								}
							}
							return true;
						})
					}
				}

				const moves = canMove.map(m => {
					let move = `move ${m.slot}`;
					// NOTE: We don't generate all possible targeting combinations.
					if (request.active.length > 1) {
						if ([`normal`, `any`, `adjacentFoe`].includes(m.target)) {
							move += ` ${1 + Math.floor(this.prng.next() * 2)}`;
						}
						if (m.target === `adjacentAlly`) {
							move += ` -${(i ^ 1) + 1}`;
						}
						if (m.target === `adjacentAllyOrSelf`) {
							if (hasAlly) {
								move += ` -${1 + Math.floor(this.prng.next() * 2)}`;
							} else {
								move += ` -${i + 1}`;
							}
						}
					}
					if (m.zMove) move += ` zmove`;
					return {choice: move, move: m};
				});

				const canSwitch = range(1, 6).filter(j => (
					pokemon[j - 1] &&
					// not active
					!pokemon[j - 1].active &&
					// not chosen for a simultaneous switch
					!chosen.includes(j) &&
					// not fainted
					!pokemon[j - 1].condition.endsWith(` fnt`)
				));
				const switches = active.trapped ? [] : canSwitch;

				if (switches.length && (!moves.length || this.prng.next() > this.move)) {
					const target = this.chooseSwitch(
						active,
						canSwitch.map(slot => ({slot, pokemon: pokemon[slot - 1]}))
					);
					chosen.push(target);
					return `switch ${target}`;
				} else if (moves.length) {
					const move = this.chooseMove(active, moves);
					if (move.endsWith(` zmove`)) {
						canZMove = false;
						return move;
					} else if (change) {
						if (canDynamax) {
							canDynamax = false;
							return `${move} dynamax`;
						} else if (canMegaEvo) {
							canMegaEvo = false;
							return `${move} mega`;
						} else {
							canUltraBurst = false;
							return `${move} ultra`;
						}
					} else {
						return move;
					}
				} else {
					throw new Error(`${this.constructor.name} unable to make choice ${i}. request='${request}',` +
						` chosen='${chosen}', (mega=${canMegaEvo}, ultra=${canUltraBurst}, zmove=${canZMove},` +
						` dynamax='${canDynamax}')`);
				}
			});
			this.choose(choices.join(`, `));
		} else {
			// team preview?
			this.choose(this.chooseTeamPreview(request.side.pokemon));
		}
	}

	protected chooseTeamPreview(team: AnyObject[]): string {
		return `default`;
	}

	protected chooseMove(active: AnyObject, moves: {choice: string, move: AnyObject}[]): string {
		return this.prng.sample(moves).choice;
	}

	protected chooseSwitch(active: AnyObject | undefined, switches: {slot: number, pokemon: AnyObject}[]): number {
		return this.prng.sample(switches).slot;
	}
}

// Creates an array of numbers progressing from start up to and including end
function range(start: number, end?: number, step = 1) {
	if (end === undefined) {
		end = start;
		start = 0;
	}
	const result = [];
	for (; start <= end; start += step) {
		result.push(start);
	}
	return result;
}

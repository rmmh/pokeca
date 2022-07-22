#!/usr/bin/env python3

import argparse
import itertools

import PIL.Image
import PIL.ImageDraw
import PIL.ImageFont
import matplotlib.pyplot as plt
import matplotlib.colors
from pyrsistent import m

parser = argparse.ArgumentParser()
parser.add_argument('--tiers', nargs='*')
parser.add_argument('--color', default='coolwarm')
parser.add_argument('--alternates', action='store_true')
parser.add_argument('--order', choices=['greedy', 'tsp'])
parser.add_argument('infile', nargs='?', default='results')
parser.add_argument('outfile', nargs='?', default='results.png')
opts = parser.parse_args()

spritesize = 24

entries = {}
genStart = 999
genEnd = 0

def loadResultsText(fname):
    global genStart, genEnd
    data = None
    for line in open(fname):
        line = line.strip()
        if 'lvl' in line:
            parts = line.split()
            num = int(parts[0])
            entries[num] = {'line': parts[1:]}
            genStart = min(genStart, num)
            genEnd = max(genEnd, num)
        if 'vs' in line or 'lvl' in line:
            continue
        if not data:
            data = [[None] * (genEnd - genStart + 1) for _ in range(genStart, genEnd + 1)]
        a, b, win, loss, tie = [int(x) for x in line.split()]

        a -= genStart
        b -= genStart

        for s in (a, b):
            data[a][a] = .5
            data[b][b] = .5

        data[a][b] = (loss+tie/2)/(win+loss+tie)
        data[b][a] = (win+tie/2)/(win+loss+tie)

    return data

def loadResultsDB(fname):
    global genStart, genEnd
    import sqlite3
    import json

    gen = int(fname[-6])
    matchups = json.load(open(fname))
    db = sqlite3.connect('battle.db')
    count = len(matchups['mons'])
    data = [[None] * (count) for _ in range(count)]

    def get_tid(packed):
        return db.execute('select id from team where packed=?', (packed,)).fetchone()[0]

    tids = {packed: get_tid(packed) for packed in matchups['mons']}

    for a in range(count):
        data[a][a] = .5
        if opts.alternates and 'alternates' in matchups:
            ms = sorted(set(itertools.chain(*[x[1] for x in matchups['alternates'][a]])),
                    key=matchups['learnsets'][a].index, reverse=True)
        else:
            ms = matchups['movesets'][a][::-1]
        entries[a] = {'moves': [x.title() for x in ms]}

    for packed, moves, alts in zip(matchups['mons'], matchups['movesets'], matchups.get('alternates', [])):
        for alt in alts:
            np = packed.replace('|' + ','.join(moves), '|' + ','.join(alt[1]))
            alt[1] = np
            tids[np] = get_tid(np)

    genStart = [1, 152, 252, 387, 494, 650][gen - 1]
    genEnd = genStart + count - 1

    def get_matchup_teams(a, b):
        if not opts.alternates or 'alternates' not in matchups:
            return matchups['mons'][a], matchups['mons'][b]
        ta, tb = None, None
        for targs, packed in matchups['alternates'][a]:
            # assert targs or ta is None, (a, matchups['mons'][a], matchups['alternates'][a])
            if b + genStart in targs or not ta:
                ta = packed
        for targs, packed in matchups['alternates'][b]:
            # TODO: handle pointless alternate movesets (ex. Venusaur)
            # assert targs or tb is None, (b, matchups['mons'][b], matchups['alternates'][b])
            if a + genStart in targs or not tb:
                tb = packed
        return ta, tb

    for a in range(count):
        for b in range(a+1, count):
            ta, tb = get_matchup_teams(a, b)
            try:
                if a < b:
                    win, loss, tie = db.execute('select win, lose, tie from results where gen=? '
                        ' and teama=? and teamb=?', (gen, tids[ta], tids[tb])).fetchone()
                else:
                    tie, loss, win = db.execute('select win, lose, tie from results where gen=? '
                        ' and teama=? and teamb=?', (gen, tids[tb], tids[ta])).fetchone()
            except TypeError:
                continue
            if not win+loss+tie:
                continue
            data[a][b] = (loss+tie/2)/(win+loss+tie)
            data[b][a] = (win+tie/2)/(win+loss+tie)

    return data

if opts.infile.endswith('.json'):
    data = loadResultsDB(opts.infile)
else:
    data = loadResultsText(opts.infile)

def cosine_similarity(xs, ys):
    sumxx, sumxy, sumyy = 0, 0, 0
    for x, y in zip(xs, ys):
        sumxx += x*x
        sumyy += y*y
        sumxy += x*y
    return sumxy/(sumxx**.5*sumyy**.5)

order = list(range(genEnd - genStart + 1))
if opts.order == 'greedy':
    todo = set(range(1, len(data)))
    cur = 1
    order = [0]
    while todo:
        nextNum = max(todo, key=lambda x: cosine_similarity(data[cur][1:], data[x][1:]))
        order.append(nextNum)
        todo.remove(nextNum)
        cur = nextNum
elif opts.order == 'tsp':
    from ortools.constraint_solver import routing_enums_pb2
    from ortools.constraint_solver import pywrapcp

    start = 0
    manager = pywrapcp.RoutingIndexManager(genEnd - genStart + 1, 1, start)
    routing = pywrapcp.RoutingModel(manager)

    dcache = {}
    def dist(a, b):
        a = manager.IndexToNode(a)
        b = manager.IndexToNode(b)

        if b == start:
            return 0

        if (a, b) not in dcache:
            xs = data[a]
            ys = data[b]
            d = 0
            d += 5*abs(sum(xs)-sum(ys))
            d += 500*sum(abs(x-y) for x, y in zip(xs, ys))
            d += min(abs(a-b) ** 2, 25) + 50*(a<b)
            dcache[(a,b)] = d

        return dcache[(a,b)]

        #return 100 - 10 * cosine_similarity(data[a+1][1:], data[b+1][1:])

    cb = routing.RegisterTransitCallback(dist)
    routing.SetArcCostEvaluatorOfAllVehicles(cb)

    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.AUTOMATIC
    search_parameters.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.AUTOMATIC
    # search_parameters.use_or_opt = True
    search_parameters.time_limit.seconds = 30
    # search_parameters.log_search = True
    search_parameters.solution_limit = 10000
    search_parameters.local_search_operators.use_relocate_neighbors = pywrapcp.BOOL_TRUE
    search_parameters.local_search_operators.use_cross_exchange = pywrapcp.BOOL_TRUE

    solution = routing.SolveWithParameters(search_parameters)

    order = []

    # Print solution on console.
    index = routing.Start(0)
    order.append(manager.IndexToNode(index))
    if solution:
        index = routing.Start(0)
        while not routing.IsEnd(index):
            previous_index = index
            index = solution.Value(routing.NextVar(index))
            order.append(manager.IndexToNode(index))
    order.pop()  # last node is a repeat

if opts.tiers:
    ts = [x.lower() for x in opts.tiers]
    order = [x for x in order if entries[x+genStart]['line'][-1].lower() in ts]

def remap(x):
    try:
        return order.index(x) + 1
    except ValueError:
        return 0

count = len(order)
basedim = (count + 1) * spritesize

mx = 16
my = 6
movewidth = 0
font = PIL.ImageFont.load("font.pil")  # gen3

for ent in entries.values():
    if 'moves' not in ent:
        continue
    ms = ent['moves']
    movewidth = max(movewidth, font.getsize(' '.join(ms[:2]))[0])
    movewidth = max(movewidth, font.getsize(' '.join(ms[2:4]))[0])

mx += movewidth

im = PIL.Image.new(mode="RGBA", size=(movewidth + basedim + 16, basedim + 8), color=(128, 128, 128))

# extracted from pokesprite's git repo under the icons/pokemon/regular dir using this cmd:
# MAGICK_OCL_DEVICE=OFF montage -background none \
# $(jq -r '.[].slug.eng + ".png" ' < ../../../data/pokemon.json | head -n 809) \
# -geometry +0+0 -tile 16x boxicons.png
sp = PIL.Image.open("boxicons.png")
if opts.color == 'redgrayblue':
    cm = matplotlib.colors.LinearSegmentedColormap.from_list('redgrayblue',
        [(1, 0, 0), (.5, .5, .5), (0, 0, 1)])
else:
    cm = plt.get_cmap(opts.color.strip('-'))
if opts.color.endswith('-'):
    cm = cm.reversed()
dr = PIL.ImageDraw.Draw(im)

for n, mon in enumerate(order, 1):
    mon += genStart
    spy = ((mon - 1) // 16) * 30
    spx = ((mon - 1) % 16) * 40
    monsp = sp.crop((spx, spy, spx + 40, spy + 30))
    im.alpha_composite(monsp, (movewidth, n * spritesize))
    im.alpha_composite(monsp, (movewidth + 8 + n * spritesize, 0))

for mon, vals in enumerate(data):
    a = remap(mon)

    try:
        ms = entries[mon]['moves']
    except KeyError:
        pass
    else:
        l1, l2 = ' '.join(ms[:2]), ' '.join(ms[2:4])
        l1w = font.getsize(l1)[0]
        l2w = font.getsize(l2)[0]
        if l2:
            dr.text((movewidth - l1w, -4 + my + a * spritesize), l1, font=font)
            dr.text((movewidth - l2w, 7 + my + a * spritesize), l2, font=font)
        else:
            dr.text((movewidth - l1w, 3 + my + a * spritesize), l1, font=font)

    for b, v in enumerate(vals):
        b = remap(b)
        if not a or not b or v is None:
            continue
        dr.rectangle((mx + (a) * spritesize, my + (b) * spritesize,
                    mx + (a + 1) * spritesize - 1, my + (b + 1) * spritesize - 1),
            tuple(int(x * 255) for x in cm(v)))


im.save(opts.outfile)

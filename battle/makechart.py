#!/usr/bin/env python3

import PIL.Image
import PIL.ImageDraw
import matplotlib.pyplot as plt
import matplotlib.colors
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--tiers', nargs='*')
parser.add_argument('--color', default='coolwarm')
parser.add_argument('--order', choices=['greedy', 'tsp'])
parser.add_argument('infile', nargs='?', default='results')
parser.add_argument('outfile', nargs='?', default='results.png')
opts = parser.parse_args()

spritesize = 24

entries = {}
genStart = 999
genEnd = 0
data = None

for line in open(opts.infile):
    line = line.strip()
    if 'lvl' in line:
        parts = line.split()
        num = int(parts[0])
        entries[num] = parts[1:]
        genStart = min(genStart, num)
        genEnd = max(genEnd, num)
    if 'vs' in line or 'lvl' in line:
        continue
    if not data:
        data = [[None] * (genEnd - genStart + 1) for _ in range(genStart, genEnd + 1)]
    a, b, win, loss, tie = [int(x) for x in line.split()]

    mx = 16
    my = 6

    a -= genStart
    b -= genStart

    for s in (a, b):
        data[a][a] = .5
        data[b][b] = .5

    data[a][b] = (loss+tie/2)/(win+loss+tie)
    data[b][a] = (win+tie/2)/(win+loss+tie)

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
    order = [x for x in order if entries[x+genStart][-1].lower() in ts]

def remap(x):
    try:
        return order.index(x) + 1
    except ValueError:
        return 0

count = len(order)
basedim = (count + 1) * spritesize

im = PIL.Image.new(mode="RGBA", size=(basedim + 16, basedim + 8), color=(128, 128, 128))

# extracted from pokesprite's git repo under the icons/pokemon/regular dir using this cmd:
# MAGICK_OCL_DEVICE=OFF montage -background none \
# $(jq -r '.[].slug.eng + ".png" ' < ../../../data/pkmn.json  | head -n 721) \
# -geometry +0+0  -tile 16x gen1.png && gliv boxicons.png
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
    im.alpha_composite(monsp, (0, n * spritesize))
    im.alpha_composite(monsp, (8 + n * spritesize, 0))

for mon, vals in enumerate(data):
    a = remap(mon)

    for b, v in enumerate(vals):
        b = remap(b)
        if not a or not b or v is None:
            continue
        dr.rectangle((mx + (a) * spritesize, my + (b) * spritesize,
                    mx + (a + 1) * spritesize - 1, my + (b + 1) * spritesize - 1),
            tuple(int(x * 255) for x in cm(v)))


im.save(opts.outfile)

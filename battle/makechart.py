import PIL.Image
import PIL.ImageDraw
import matplotlib.pyplot as plt
import sys

spritesize = 24
count = 151
basedim = (count + 1) * spritesize

im = PIL.Image.new(mode="RGBA", size=(basedim + 16, basedim + 8), color=(128, 128, 128))

# extracted from pokesprite's git repo under the icons/pokemon/regular dir using this cmd:
# MAGICK_OCL_DEVICE=OFF montage -background none \
# $(jq -r '.[].slug.eng + ".png" ' < ../../../data/pkmn.json  | head -n 721) \
# -geometry +0+0  -tile 16x gen1.png && gliv boxicons.png
sp = PIL.Image.open("boxicons.png")

for mon in range(1, count + 1):
    spy = ((mon - 1) // 16) * 30
    spx = ((mon - 1) % 16) * 40
    # print(mon, spx, spy)
    monsp = sp.crop((spx, spy, spx + 40, spy + 30))
    im.alpha_composite(monsp, (0, mon * spritesize))
    im.alpha_composite(monsp, (8 + mon * spritesize, 0))

cm = plt.get_cmap('inferno')
dr = PIL.ImageDraw.Draw(im)

for line in open(sys.argv[1] if len(sys.argv) > 1 else "results"):
    line = line.strip()
    if "vs" in line:
        continue
    a, b, win, loss, tie = [int(x) for x in line.split()]

    mx = 16
    my = 6

    for s in (a, b):
        dr.rectangle((mx + (s) * spritesize, my + (s) * spritesize,
                    mx + (s + 1) * spritesize - 1, my + (s + 1) * spritesize - 1),
            tuple(int(x * 255) for x in cm.colors[128]))

    dr.rectangle((mx + (a) * spritesize, my + (b) * spritesize,
                  mx + (a + 1) * spritesize - 1, my + (b + 1) * spritesize - 1),
        tuple(int(x * 255) for x in cm.colors[int((loss+tie/2)*255/100)]))

    dr.rectangle((mx + (b) * spritesize, my + (a) * spritesize,
                  mx + (b + 1) * spritesize - 1, my + (a + 1) * spritesize - 1),
        tuple(int(x * 255) for x in cm.colors[int((win+tie/2)*255/100)]))



im.save("results.png")

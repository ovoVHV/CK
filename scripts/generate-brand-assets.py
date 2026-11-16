"""Derive CK assets and optically fitted small Windows icons.
Requires Pillow. Run from any directory with: py -3 scripts/generate-brand-assets.py
"""
from pathlib import Path
from PIL import Image, ImageDraw
import base64
import io
import struct

ROOT = Path(__file__).resolve().parent.parent
source = Image.open(ROOT / 'design/brand/ck-source.png').convert('RGB')
light = Image.new('RGBA', source.size)
pixels = []
for r, g, b in source.getdata():
    # Remove the white matte while retaining antialiased edges and orange tones.
    matte = min(r, g, b)
    alpha = 255 - matte
    if alpha < 10:
        pixels.append((0, 0, 0, 0))
    else:
        pixels.append((round((r-matte)*255/alpha), round((g-matte)*255/alpha), round((b-matte)*255/alpha), alpha))
light.putdata(pixels)
light = light.crop(light.getbbox())
dark = light.copy()
dark.putdata([(245,246,248,a) if max(r,g,b)-min(r,g,b)<35 else (r,g,b,a) for r,g,b,a in light.getdata()])
public = ROOT / 'desktop/apps/desktop/public'
brand = public / 'brand'
brand.mkdir(exist_ok=True)
light.save(brand / 'ck-mark-light.png', optimize=True)
dark.save(brand / 'ck-mark-dark.png', optimize=True)

def full_tile(size):
    # Render at 4x before downsizing, including the 16px/20px Windows variants.
    canvas = Image.new('RGBA', (size*4,size*4))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((2,2,size*4-3,size*4-3), radius=size*.65, fill='#ffffff', outline='#d9dde3', width=max(1,round(size*.025)))
    mark = light.copy()
    mark.thumbnail((round(size*3.6),round(size*3.6)),Image.Resampling.LANCZOS)
    # thumbnail never enlarges; resize explicitly for the larger app assets.
    width=round(size*3.6)
    mark=light.resize((width,round(width*light.height/light.width)),Image.Resampling.LANCZOS)
    canvas.alpha_composite(mark,((canvas.width-mark.width)//2,(canvas.height-mark.height)//2))
    return canvas.resize((size,size),Image.Resampling.LANCZOS)

def compact_tile(size):
    # Tiny Windows surfaces cannot retain the full mark's circuit terminals,
    # white cuts and wide aspect ratio. Keep the C/K and orange circuit, with
    # integer-aligned stems and a taller, simpler silhouette at each real size.
    scale = 4
    canvas = Image.new('RGBA', (size*scale, size*scale))
    draw = ImageDraw.Draw(canvas)
    def xy(points):
        return [(round(x*size/32)*scale, round(y*size/32)*scale) for x,y in points]
    def polygon(points,fill): draw.polygon(xy(points), fill=fill)
    draw.rounded_rectangle((0,0,size*scale-1,size*scale-1),radius=round(size*.17)*scale,fill='#ffffff')
    polygon([(14,6),(8,6),(3,11),(3,15),(7,15),(7,12),(9,10),(14,10)], '#111111')
    polygon([(3,19),(3,22),(7,26),(14,26),(14,22),(9,22),(7,20),(7,19)], '#111111')
    polygon([(17,6),(21,6),(21,12),(17,15)], '#111111')
    polygon([(17,20),(21,19),(21,26),(17,26)], '#111111')
    # A solid one-pixel-or-wider trace survives 100% and fractional DPI sizes.
    polygon([(3,16),(17,16),(25,6),(30,6),(20,18),(3,18)], '#ff6500')
    polygon([(20,19),(24,19),(30,26),(25,26)], '#ff6500')
    return canvas.resize((size,size),Image.Resampling.LANCZOS)

def tile(size):
    return compact_tile(size) if size <= 64 else full_tile(size)

icons=ROOT/'desktop/apps/desktop/src-tauri/icons'
sizes={'32x32.png':32,'128x128.png':128,'128x128@2x.png':256,'icon.png':512,'StoreLogo.png':50}
for size in [30,44,71,89,107,142,150,284,310]: sizes[f'Square{size}x{size}Logo.png']=size
for name,size in sizes.items(): tile(size).save(icons/name,optimize=True)
ico_sizes=[64,16,20,24,32,40,48,128,256]
# Tauri 2.5's Windows context decodes entries()[0], not the largest frame.
# Pillow sorts ICO entries smallest-first, which made Tauri enlarge 16px on
# the taskbar. Write explicit PNG frames and put the compact 64px mark first;
# Windows Explorer/NSIS still select their native size from the complete set.
frames=[]
for size in ico_sizes:
    buf=io.BytesIO();tile(size).save(buf,format='PNG',optimize=True)
    frames.append(buf.getvalue())
offset=6+16*len(frames)
directory=[]
for size,frame in zip(ico_sizes,frames):
    directory.append(struct.pack('<BBBBHHII',size%256,size%256,0,0,1,32,len(frame),offset))
    offset+=len(frame)
(icons/'icon.ico').write_bytes(struct.pack('<HHH',0,1,len(frames))+b''.join(directory)+b''.join(frames))
tile(1024).save(icons/'icon.icns',format='ICNS')
tile(128).save(brand/'ck-app.png',optimize=True)
# Keep the existing favicon URL. This SVG deliberately embeds the supplied
# raster artwork; it is not presented as a recreated vector master.
buf=io.BytesIO();tile(128).save(buf,format='PNG',optimize=True)
(public/'ck.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="CK"><image width="128" height="128" href="data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode()+'"/></svg>\n',encoding='utf8')

sheet=Image.new('RGB',(720,310),'#f5f6f8');d=ImageDraw.Draw(sheet)
sheet.paste('#181a1e',(360,0,720,150))
for mark,x in [(light,24),(dark,384)]:
    preview=mark.resize((300,round(mark.height*300/mark.width)),Image.Resampling.LANCZOS)
    sheet.paste(preview,(x,8),preview)
for size,x in [(16,24),(24,70),(32,124),(48,192),(64,280),(128,390)]:
    icon=tile(size);sheet.paste(icon,(x,170),icon);d.text((x,170+size+4),str(size),fill='#202124')
out=ROOT/'local/brand-preview.png';out.parent.mkdir(exist_ok=True);sheet.save(out)
print(f'Generated CK marks, app icons and {out}')

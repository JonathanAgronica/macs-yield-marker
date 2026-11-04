from PIL import Image, ImageDraw, ImageFilter, ImageEnhance
import base64, io
src=Image.open('Macadamia-nut-912598.jpg').convert('RGB')
cx0,cy0,cs=int(__import__('os').environ.get('CX','250')),int(__import__('os').environ.get('CY','1250')),1700
crop=src.crop((cx0,cy0,cx0+cs,cy0+cs))
crop=ImageEnhance.Contrast(crop).enhance(1.08); crop=ImageEnhance.Color(crop).enhance(1.12); crop=ImageEnhance.Brightness(crop).enhance(0.82)
S=2048
mk_a=Image.open('mark.png').getchannel('A')
OP=float(__import__('os').environ.get('OP','0.5'))
def grad(size):
    # orange #ffb400 radial-ish gradient
    base=Image.new('RGB',(size,size),(255,180,0))
    hl=Image.new('RGB',(size,size),(255,214,92))
    m=Image.radial_gradient('L').resize((size,size)); m=m.point(lambda v:max(0,255-v*1.6)).point(lambda v:int(v*0.55))
    return Image.composite(hl,base,m)
def rrect_mask(size,r):
    m=Image.new('L',(size,size),0); ImageDraw.Draw(m).rounded_rectangle([0,0,size-1,size-1],r,fill=255); return m
def make(maskable, out=S):
    s=S
    bg=grad(s)
    if not maskable:
        canvas=Image.new('RGBA',(s,s),(0,0,0,0))
        canvas.paste(bg,(0,0),rrect_mask(s,int(s*0.22)))
        d=0.80
    else:
        canvas=bg.convert('RGBA'); d=0.66
    D=int(s*d); x=(s-D)//2
    ph=crop.resize((D,D),Image.LANCZOS)
    cm=Image.new('L',(D,D),0); ImageDraw.Draw(cm).ellipse([0,0,D-1,D-1],fill=255)
    # shadow
    sh=Image.new('RGBA',(s,s),(0,0,0,0)); ImageDraw.Draw(sh).ellipse([x,x+int(s*0.012),x+D,x+D+int(s*0.012)],fill=(90,50,0,150))
    sh=sh.filter(ImageFilter.GaussianBlur(s*0.012)); canvas=Image.alpha_composite(canvas,sh)
    # white ring
    rw=int(s*0.018)
    ring=Image.new('RGBA',(s,s),(0,0,0,0)); ImageDraw.Draw(ring).ellipse([x-rw,x-rw,x+D+rw,x+D+rw],fill=(255,255,255,255))
    canvas=Image.alpha_composite(canvas,ring)
    canvas.paste(ph.convert('RGBA'),(x,x),cm)
    # semi-transparent white Agronica mark centred over the photo
    mw=int(s*(0.54 if not maskable else 0.44)); mh=int(mw*1105/1110)
    a=mk_a.resize((mw,mh),Image.LANCZOS).point(lambda v:int(v*OP))
    wm=Image.new('RGBA',(mw,mh),(255,255,255,0)); wm.putalpha(a)
    lay=Image.new('RGBA',(s,s),(0,0,0,0)); lay.paste(wm,((s-mw)//2,(s-mh)//2+int(s*0.004)))
    canvas=Image.alpha_composite(canvas,lay)
    return canvas
anyi=make(False); mk=make(True)
anyi.save('any2048.png'); mk.save('mask2048.png')
I='/workspace/macs-yield-marker/icons/'
for n,im,sz in [('logo.png',anyi,512),('icon-512.png',anyi,512),('icon-192.png',anyi,192),('icon-180.png',anyi,180),('favicon-32.png',anyi,32),
                ('maskable-512.png',mk,512),('maskable-192.png',mk,192)]:
    im.resize((sz,sz),Image.LANCZOS).save(I+n,optimize=True)
# favicon.ico
anyi.resize((256,256),Image.LANCZOS).save(I+'favicon.ico',sizes=[(16,16),(32,32),(48,48)])
# svg favicon w/ embedded png
b=io.BytesIO(); anyi.resize((96,96),Image.LANCZOS).save(b,'PNG',optimize=True)
open(I+'favicon.svg','w').write('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 96 96" width="96" height="96"><image width="96" height="96" href="data:image/png;base64,'+base64.b64encode(b.getvalue()).decode()+'"/></svg>')
# preview
P=Image.new('RGB',(1300,640),(32,32,32))
P.paste(anyi.resize((560,560)),(20,40),anyi.resize((560,560)))
cm=Image.new('L',(300,300),0); ImageDraw.Draw(cm).ellipse([0,0,299,299],fill=255)
P.paste(mk.resize((300,300)),(620,40),cm)
P.paste(mk.resize((300,300)),(950,40),rrect_mask(300,66))
for k,sz in enumerate([180,96,48,32]):
    t=anyi.resize((sz,sz),Image.LANCZOS); P.paste(t,(620+k*200,380),t)
P.save('/workspace/myl-icon-preview.png')

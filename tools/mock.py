# Mock of the XPGlassPad plugin HTTP API for UI testing
import io, json, sys, time, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from PIL import Image, ImageDraw
WEB = sys.argv[1]; BOUND = sys.argv[2].split(',') if len(sys.argv) > 2 else ['pfd1','mfd']
DEV = [('pfd1','G1000 PFD 1','g1000','sim/GPS/g1000n1_',1024,768),('mfd','G1000 MFD','g1000','sim/GPS/g1000n3_',1024,768),
       ('pfd2','G1000 PFD 2','g1000','sim/GPS/g1000n2_',1024,768),('gns530_1','GNS 530 #1','gns530','sim/GPS/g430n1_',640,480),
       ('gns430_1','GNS 430 #1','gns430','sim/GPS/g430n1_',480,256),('gns530_2','GNS 530 #2','gns530','sim/GPS/g430n2_',640,480),
       ('gns430_2','GNS 430 #2','gns430','sim/GPS/g430n2_',480,256),('mcdu_1','MCDU 1','mcdu','sim/FMS/',560,420),('cdu739_1','CDU 1','cdu','sim/FMS/',480,400),('tl_mcdu_1','MCDU 1','mcdu','AirbusFBW/MCDU1',24,14)]
LOG = []
LIT = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
TL = [('    INIT       ', 'w','L'), ('CO RTE        FROM/TO', 'w','S'), ('\u2610\u2610\u2610\u2610\u2610\u2610\u2610\u2610\u2610\u2610   \u2610\u2610\u2610\u2610/\u2610\u2610\u2610\u2610', 'a','L'),
  ('ALTN/CO RTE      INIT ', 'w','S'), ('----/----------  REQUEST*', 'b','L'), ('FLT NBR', 'w','S'), ('\u2610\u2610\u2610\u2610\u2610\u2610\u2610\u2610', 'a','L'),
  ('', 'w','S'), ('', 'w','L'), ('COST INDEX', 'w','S'), ('---           WIND/TEMP>', 'w','L'), ('CRZ FL/TEMP      TROPO', 'w','S'), ('-----/---\u00b0       36090', 'b','L'), ('', 'w','L')]
def frame(key, w, h):
    im = Image.new('RGB', (w, h), (0, 0, 0)); d = ImageDraw.Draw(im)
    if 'cdu' in key:
        from PIL import ImageFont
        lh = h / 14; f = ImageFont.load_default(size=int(lh * .8)); fs = ImageFont.load_default(size=int(lh * .6))
        G = (0, 220, 90); C = (0, 200, 255)
        rows = {0: ('        INIT', 'white', 0), 1: (' CO RTE        FROM/TO', 'white', 1), 2: ('[       ]   EDDF/EDDM', C, 0), 3: ('ALTN/CO RTE', 'white', 1),
                4: ('----/---------', C, 0), 5: ('FLT NBR', 'white', 1), 6: ('[      ]', C, 0), 7: ('LAT          LONG', 'white', 1),
                8: ('----.-    ----.-', 'white', 0), 9: ('COST INDEX', 'white', 1), 10: ('---          WIND>', 'white', 0),
                11: ('CRZ FL/TEMP   TROPO', 'white', 1), 12: ('-----/---°   36090', C, 0)}
        for i, (t, c, small) in rows.items():
            ff = fs if small else f
            d.text((8, i * lh + lh / 2), t, fill=c, font=ff, anchor='lm')
        b = io.BytesIO(); im.save(b, 'JPEG', quality=85); return b.getvalue()
    d.rectangle([0, 0, w, h//2], fill=(30, 90, 200)); d.rectangle([0, h//2, w, h], fill=(130, 85, 40))
    d.line([0, h//2, w, h//2], fill='white', width=3)
    d.text((20, 20), f'{key}  {time.strftime("%H:%M:%S")}', fill='white')
    b = io.BytesIO(); im.save(b, 'JPEG', quality=80); return b.getvalue()
class H(SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=WEB, **k)
    def log_message(s, *a): pass
    def do_GET(s):
        u = urlparse(s.path); q = parse_qs(u.query)
        if u.path == '/api/status':
            body = json.dumps({'aircraft': 'Cessna 172 SP G1000 (Mock)', 'acf': 'Cessna_172SP_G1000.acf', 'fps': 20, 'pbo': True,
              'light': {'avionics': True, 'inst': [LIT]*32, 'instMan': [LIT]*32, 'panel': [LIT]*4, 'tlInteg': [LIT, LIT], 'tlPower': True},
              'devices': [dict(key=k, name=n, kind=t, prefix=p, text=k.startswith(('tl_','mcdu','cdu')), bound=k in BOUND, drawing=True, w=w, h=h, captures=0, readMs=0.4) for k,n,t,p,w,h in DEV]}).encode()
            return s.reply(200, 'application/json', body)
        if u.path.startswith('/frame/'):
            k = u.path[7:]; d = [x for x in DEV if x[0] == k][0]; time.sleep(0.1)
            s.send_response(200); b = frame(k, d[4], d[5])
            s.send_header('Content-Type', 'image/jpeg'); s.send_header('X-Seq', str(int(time.time()*10))); s.send_header('Content-Length', str(len(b))); s.end_headers(); s.wfile.write(b); return
        if u.path.startswith('/text/'):
            time.sleep(0.05 if 'after=0' in s.path else 1.0)
            lines = [dict(t=(t+' '*24)[:24], c=c*24, s=z*24) for t,c,z in TL]
            body = json.dumps({'br': 1, 'lines': lines}).encode()
            s.send_response(200); s.send_header('Content-Type','application/json'); s.send_header('X-Seq','1'); s.send_header('Content-Length', str(len(body))); s.end_headers(); s.wfile.write(body); return
        if u.path == '/api/cmd':
            LOG.append((q.get('c',[''])[0], q.get('m',['once'])[0], q.get('n',['1'])[0])); print('CMD', LOG[-1], flush=True)
            return s.reply(200, 'text/plain', b'ok')
        return super().do_GET()
    def reply(s, code, ct, body):
        s.send_response(code); s.send_header('Content-Type', ct); s.send_header('Content-Length', str(len(body))); s.end_headers(); s.wfile.write(body)
ThreadingHTTPServer(('127.0.0.1', int(sys.argv[3]) if len(sys.argv) > 3 else 8099), H).serve_forever()

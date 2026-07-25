# Muestrea el índice de riesgo de incendios de AEMET (GeoTIFF diario, escala
# 1-6) en puntos representativos de las comunidades sin fuente propia, y
# publica aemet/aemet.json. Python puro (TIFF sin comprimir, float32, WGS84).
# Uso: python3 parse-aemet.py [ruta_tar_gz] — sin argumento, descarga de AEMET.
import struct, tarfile, json, sys, urllib.request, datetime, io, re

DOWNLOAD = 'https://www.aemet.es/es/api-eltiempo/incendios/download'

# Puntos interiores (lon, lat) por comunidad — el nivel mostrado es el MÁXIMO
# de los puntos muestreados (capitales + cabeceras repartidas por el territorio).
POINTS = {
  'madrid': [(-3.70,40.42),(-3.37,40.48),(-3.60,40.03),(-4.01,40.29),(-4.15,40.58),
             (-3.64,41.00),(-3.88,40.90),(-3.54,40.83),(-3.42,40.14),(-4.24,40.50)],
  'murcia': [(-1.13,37.99),(-0.99,37.63),(-1.70,37.68),(-1.86,38.11),(-1.32,38.48),
             (-1.11,38.61),(-1.42,38.24),(-1.58,37.41),(-1.89,38.19),(-1.49,38.04)],
  'cantabria': [(-3.80,43.46),(-4.05,43.35),(-4.14,43.00),(-4.62,43.15),(-3.46,43.25),
                (-4.23,43.31),(-4.39,43.38),(-3.81,43.23),(-3.98,42.85)],
  'castilla-leon': [(-4.72,41.65),(-5.57,42.60),(-3.70,42.34),(-5.66,40.96),(-5.75,41.50),
                    (-4.68,40.66),(-4.12,40.95),(-2.46,41.77),(-4.52,42.01),(-6.59,42.55),
                    (-6.53,40.60),(-5.76,40.39),(-3.69,41.67),(-2.53,41.48),(-5.68,42.00),
                    (-4.50,42.87),(-5.00,42.98),(-6.70,42.10),(-5.52,40.36)],
  'baleares': [(2.65,39.57),(2.91,39.72),(3.21,39.57),(3.02,39.87),(2.89,39.49),
               (4.26,39.89),(3.84,40.00),(1.43,38.91),(1.30,38.98)],
}

def read_tiff(buf):
    bo = '<' if buf[:2] == b'II' else '>'
    off, = struct.unpack(bo + 'I', buf[4:8])
    n, = struct.unpack(bo + 'H', buf[off:off + 2])
    tags = {}
    for i in range(n):
        e = off + 2 + i * 12
        tag, typ, cnt = struct.unpack(bo + 'HHI', buf[e:e + 8])
        tags[tag] = (typ, cnt, buf[e + 8:e + 12])
    def val(tag):
        typ, cnt, vb = tags[tag]
        size = {1: 1, 3: 2, 4: 4, 11: 4, 12: 8}[typ]
        total = size * cnt
        data = vb[:total] if total <= 4 else buf[struct.unpack(bo + 'I', vb)[0]:][:total]
        fmt = {1: 'B', 3: 'H', 4: 'I', 11: 'f', 12: 'd'}[typ]
        return list(struct.unpack(bo + str(cnt) + fmt, data))
    if 259 in tags and val(259)[0] != 1:
        raise SystemExit('TIFF comprimido: el parser solo soporta sin compresión')
    w, h = val(256)[0], val(257)[0]
    bps = val(258)[0]
    sf = val(339)[0] if 339 in tags else 1
    offs, counts = val(273), val(279)
    scale, tie = val(33550), val(33922)
    raw = b''.join(buf[o:o + c] for o, c in zip(offs, counts))
    return dict(w=w, h=h, bps=bps, sf=sf, raw=raw, bo=bo,
                sx=scale[0], sy=scale[1], ox=tie[3], oy=tie[4])

def sample(t, lon, lat):
    col = int((lon - t['ox']) / t['sx'])
    row = int((t['oy'] - lat) / t['sy'])
    if not (0 <= col < t['w'] and 0 <= row < t['h']):
        return None
    i = row * t['w'] + col
    if t['sf'] == 3 and t['bps'] == 32:
        v, = struct.unpack(t['bo'] + 'f', t['raw'][i * 4:i * 4 + 4])
    elif t['bps'] == 8:
        v = t['raw'][i]
    else:
        return None
    if v != v:  # NaN
        return None
    v = int(round(v))
    return v if 1 <= v <= 6 else None

def region_max(t, points):
    vals = [sample(t, lon, lat) for lon, lat in points]
    vals = [v for v in vals if v is not None]
    return max(vals) if vals else None

def main():
    if len(sys.argv) > 1:
        data = open(sys.argv[1], 'rb').read()
    else:
        req = urllib.request.Request(DOWNLOAD, headers={'User-Agent': 'PuedoRodar/1.0'})
        data = urllib.request.urlopen(req, timeout=120).read()
    tar = tarfile.open(fileobj=io.BytesIO(data), mode='r:gz')
    tifs = {}
    run = None
    for m in tar.getmembers():
        g = re.match(r'.*down_(\d{8})_peligro_p_D(\d{2})\.tif$', m.name)
        if g:
            run = g.group(1)
            tifs[int(g.group(2))] = tar.extractfile(m).read()
    if not run:
        raise SystemExit('sin GeoTIFFs peninsulares en el tar')
    run_date = datetime.date(int(run[:4]), int(run[4:6]), int(run[6:8]))
    today = datetime.date.today()
    idx = (today - run_date).days
    if not (0 <= idx <= 6):
        raise SystemExit(f'pasada {run_date} demasiado vieja para hoy {today}')
    t_today = read_tiff(tifs[idx])
    t_tomorrow = read_tiff(tifs[idx + 1]) if idx + 1 in tifs else None
    out = {
        'day': today.isoformat(),
        'run': run_date.isoformat(),
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'regions': {
            code: {
                'today': region_max(t_today, pts),
                'tomorrow': region_max(t_tomorrow, pts) if t_tomorrow else None,
            }
            for code, pts in POINTS.items()
        },
    }
    print(json.dumps(out, indent=1))

if __name__ == '__main__':
    main()

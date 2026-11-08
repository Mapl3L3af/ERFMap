"""Validate registered reconstruction terrain and contour only observed grid cells."""
import math


def build_terrain(data, scale, mosaic):
    if not isinstance(data, dict) or data.get('units') != 'metres' or data.get('coordinates') != 'mosaic-pixels':
        raise ValueError('Terrain requires metre heights and mosaic-pixels registration.')
    for key in ('scaled', 'gravity_aligned', 'ground_filtered'):
        if data.get(key) is not True:
            raise ValueError('Terrain reconstruction must be ' + key)
    if not isinstance(data.get('source'), str) or not data['source'].strip():
        raise ValueError('Terrain requires reconstruction provenance.')
    grid = data.get('grid', [])
    if not isinstance(grid, list) or not 2 <= len(grid) <= 256 or not isinstance(grid[0], list) or not 2 <= len(grid[0]) <= 256:
        raise ValueError('Terrain grid must be 2–256 rows and columns.')
    width = len(grid[0])
    if any(not isinstance(row, list) or len(row) != width for row in grid):
        raise ValueError('Terrain grid must be rectangular.')
    def finite(v):
        return type(v) in (int, float) and math.isfinite(v)
    origin, step = data.get('origin_px'), data.get('step_px')
    if not all(isinstance(v, list) and len(v) == 2 and all(finite(x) for x in v) for v in (origin, step)) or min(step) <= 0:
        raise ValueError('Terrain requires finite origin and positive grid spacing.')
    if min(origin) < 0 or origin[0] + (width-1)*step[0] >= mosaic['width'] or origin[1] + (len(grid)-1)*step[1] >= mosaic['height']:
        raise ValueError('Terrain grid lies outside the registered scene.')
    values = [z for row in grid for z in row if z is not None]
    if len(values) < 4 or not all(finite(z) for z in values):
        raise ValueError('Terrain needs at least four finite ground heights; use null for holes.')
    datum = min(values)
    interval = data.get('interval_m', 0.5)
    if not finite(interval) or interval <= 0 or (max(values)-datum)/interval > 200:
        raise ValueError('Choose a positive contour interval producing at most 200 levels.')
    points, samples, contours = [], [], []
    for y, row in enumerate(grid):
        points.append([])
        for x, z in enumerate(row):
            p = None if z is None else [
                (origin[0]+x*step[0]-scale['origin_px'][0])*scale['m_per_px'],
                (origin[1]+y*step[1]-scale['origin_px'][1])*scale['m_per_px'], z-datum]
            points[-1].append(p)
            if p is not None:
                samples.append(p)
    cells = 0
    for y in range(len(grid)-1):
        for x in range(width-1):
            a,b,c,d = points[y][x],points[y][x+1],points[y+1][x+1],points[y+1][x]
            if any(p is None for p in (a,b,c,d)):
                continue
            cells += 1
            for triangle in ((a,b,c),(a,c,d)):
                low, high = min(p[2] for p in triangle), max(p[2] for p in triangle)
                for level in range(math.ceil(low/interval), math.ceil(high/interval)):
                    height, hits = level*interval, []
                    for p,q in zip(triangle, triangle[1:]+triangle[:1]):
                        if min(p[2],q[2]) <= height < max(p[2],q[2]):
                            t = (height-p[2])/(q[2]-p[2])
                            hits.append([p[k]+t*(q[k]-p[k]) for k in (0,1)])
                    if len(hits) == 2 and hits[0] != hits[1]:
                        contours.append({'height': height, 'points': hits})
                        if len(contours) > 100000:
                            raise ValueError('Terrain exceeds 100000 contour segments; increase interval or grid spacing.')
    if not cells:
        raise ValueError('Terrain has no fully observed grid cells.')
    return {'groundGrid': {'origin': [(origin[i]-scale['origin_px'][i])*scale['m_per_px'] for i in (0,1)],
                           'step': [v*scale['m_per_px'] for v in step],
                           'heights': [[None if z is None else z-datum for z in row] for row in grid]},
            'samples': samples, 'contours': contours, 'source': data['source'],
            'interval_m': interval, 'verticalDatum': 'relative to lowest observed ground sample',
            'sourceDatumOffset_m': datum, 'observedCells': cells,
            'note': 'Contours cover observed ground cells only. Terrain between samples is estimated.'}

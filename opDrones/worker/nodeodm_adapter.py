#!/usr/bin/env python3
"""NodeODM ground adapter. Reads the erfMap reconstruction request on stdin.

Requires rasterio in the worker environment. The ODM DTM and orthophoto must
share a projected, metre-based CRS; the image registration is independently
checked against erfMap's mosaic. ODM uses the supplied measured ground distance
to establish the vertical metric scale for otherwise unreferenced imagery.
"""
import json
import hashlib
import mimetypes
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import cv2
import numpy as np


def api(base, endpoint, payload=None, timeout=60):
    url=base.rstrip('/')+endpoint
    request=urllib.request.Request(url, data=payload, headers={'Content-Type':'application/x-www-form-urlencoded'} if payload is not None else {})
    try:
        with urllib.request.urlopen(request,timeout=timeout) as response:
            result = json.load(response)
            if isinstance(result, dict) and (result.get('error') or result.get('success') is False):
                raise RuntimeError('NodeODM '+endpoint+': '+str(result))
            return result
    except urllib.error.URLError as exc:
        raise RuntimeError('NodeODM request failed at '+endpoint+': '+str(exc)) from exc


def upload(base, uuid, path):
    boundary='erfmap'+os.urandom(12).hex()
    filename=path.name.encode('utf-8')
    content_type=mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    prefix=b'--'+boundary.encode()+b'\r\nContent-Disposition: form-data; name="images"; filename="'+filename+b'"\r\nContent-Type: '+content_type.encode()+b'\r\n\r\n'
    suffix=b'\r\n--'+boundary.encode()+b'--\r\n'
    # Upload one original photo or extracted frame at a time.
    data=prefix+path.read_bytes()+suffix
    request=urllib.request.Request(base.rstrip('/')+'/task/new/upload/'+uuid,data=data,headers={'Content-Type':'multipart/form-data; boundary='+boundary},method='POST')
    with urllib.request.urlopen(request,timeout=300) as response:
        result=json.load(response)
    if result.get('success') is False:raise RuntimeError('NodeODM rejected '+path.name+': '+str(result))


def register(orthophoto, mosaic):
    def features(image):
        gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY) if image.ndim==3 else image
        height,width=gray.shape
        factor=min(1,1800/max(height,width))
        if factor<1:gray=cv2.resize(gray,None,fx=factor,fy=factor,interpolation=cv2.INTER_AREA)
        key,desc=cv2.SIFT_create(nfeatures=8000).detectAndCompute(gray,None)
        return key,desc,factor
    a,da,sa=features(orthophoto);b,db,sb=features(mosaic)
    if da is None or db is None:raise RuntimeError('No image features for orthophoto registration.')
    matches=cv2.BFMatcher().knnMatch(da,db,k=2)
    good=[m for m,n in matches if m.distance<.7*n.distance]
    if len(good)<30:raise RuntimeError('ODM orthophoto could not be matched to the stitched map (fewer than 30 distinct matches).')
    src=np.float32([a[m.queryIdx].pt for m in good])/sa
    dst=np.float32([b[m.trainIdx].pt for m in good])/sb
    H,inliers=cv2.findHomography(src,dst,cv2.RANSAC,4)
    if H is None or int(inliers.sum())<25 or inliers.mean()<.35:
        raise RuntimeError('ODM orthophoto registration lacks geometrically consistent matches.')
    projected=cv2.perspectiveTransform(src[None,:,:],H)[0]
    errors=np.linalg.norm(projected-dst,axis=1)[inliers.ravel().astype(bool)]
    if float(np.median(errors))>8:raise RuntimeError('ODM orthophoto registration error exceeds 8 mosaic pixels.')
    return H, {'matches':len(good),'inliers':int(inliers.sum()),'medianErrorPx':round(float(np.median(errors)),2)}


def terrain_from_rasters(dtm_path, ortho_path, request):
    import rasterio
    from rasterio.warp import transform as reproject
    mosaic=request['mosaic']; image=cv2.imread(str(Path(request['job'])/mosaic['image']))
    if image is None:raise RuntimeError('Stitched erfMap mosaic is unavailable.')
    with rasterio.open(ortho_path) as ortho, rasterio.open(dtm_path) as dtm:
        if not ortho.crs or not dtm.crs or ortho.crs.is_geographic or dtm.crs.is_geographic:
            raise RuntimeError('ODM output needs a projected metre CRS for vertical scale; geographic or unreferenced rasters cannot establish it.')
        if 'metre' not in str(ortho.crs.linear_units).lower() and 'meter' not in str(ortho.crs.linear_units).lower():
            raise RuntimeError('ODM orthophoto coordinates must use metres.')
        if 'metre' not in str(dtm.crs.linear_units).lower() and 'meter' not in str(dtm.crs.linear_units).lower():
            raise RuntimeError('ODM ground heights must use metres.')
        bands=ortho.read(list(range(1,min(3,ortho.count)+1)),out_dtype='uint8')
        if bands.shape[0]<3:ortho_image=np.repeat(bands[0,:,:,None],3,axis=2)
        else:ortho_image=cv2.cvtColor(np.moveaxis(bands,0,2),cv2.COLOR_RGB2BGR)
        if mosaic.get('source') == 'NodeODM':
            # The preview is a resize of this exact raster, not a second stitch.
            H=np.diag([mosaic['width']/ortho.width,mosaic['height']/ortho.height,1.0])
            quality={'method':'orthophoto pixel transform; no image matching'}
        else:
            H,quality=register(ortho_image,image)
        inv=np.linalg.inv(H)
        step=[max(1,(mosaic['width']-1)//min(128,mosaic['width']-1)),max(1,(mosaic['height']-1)//min(128,mosaic['height']-1))]
        nx=min(256,1+(mosaic['width']-1)//step[0]);ny=min(256,1+(mosaic['height']-1)//step[1])
        if nx<2 or ny<2:raise RuntimeError('Map preview is too small for a terrain grid.')
        xs=np.arange(nx,dtype=np.float32)*step[0];ys=np.arange(ny,dtype=np.float32)*step[1]
        targets=np.float32(np.stack(np.meshgrid(xs,ys),axis=-1).reshape(1,-1,2))
        pixels=cv2.perspectiveTransform(targets,inv)[0]
        coords=[ortho.transform @ (float(x)+.5,float(y)+.5) for x,y in pixels]
        if ortho.crs!=dtm.crs:
            X,Y=reproject(ortho.crs,dtm.crs,[p[0] for p in coords],[p[1] for p in coords]);coords=list(zip(X,Y))
        band=dtm.read(1,masked=True)
        values=[]
        for x,y in coords:
            row,col=dtm.index(x,y)
            if row<0 or col<0 or row>=dtm.height or col>=dtm.width or np.ma.is_masked(band[row,col]) or not math.isfinite(float(band[row,col])):values.append(None)
            else:values.append(float(band[row,col]))
        grid=[values[i*nx:(i+1)*nx] for i in range(ny)]
        observed=sum(all(grid[j][i+k] is not None for k in (0,1)) and all(grid[j+1][i+k] is not None for k in (0,1)) for j in range(ny-1) for i in range(nx-1))
        if observed<4:raise RuntimeError('Registered DTM has too few observed ground cells; check overlap and orthophoto alignment.')
        # ODM's 3D model has one uniform unknown scale without GPS/GCP. The
        # reviewer-supplied ground distance fixes that scale in the registered map.
        cx,cy=mosaic['width']/2,mosaic['height']/2
        sample=cv2.perspectiveTransform(np.float32([[[cx,cy],[cx+100,cy],[cx,cy+100]]]),inv)[0]
        world=[ortho.transform @ (float(x)+.5,float(y)+.5) for x,y in sample]
        model_per_px=(math.dist(world[0],world[1])+math.dist(world[0],world[2]))/200
        if not math.isfinite(model_per_px) or model_per_px<=0:raise RuntimeError('ODM horizontal reconstruction scale is invalid.')
        vertical_scale=request['scale']['m_per_px']/model_per_px
        if not math.isfinite(vertical_scale) or vertical_scale<=0:raise RuntimeError('Cannot establish the ODM vertical scale from the measured ground reference.')
        grid=[[None if z is None else z*vertical_scale for z in row] for row in grid]
        return dict(units='metres',coordinates='mosaic-pixels',scaled=True,gravity_aligned=True,ground_filtered=True,
                    source='NodeODM DTM; measured horizontal scale applied equally to vertical; registration '+json.dumps(quality),origin_px=[0,0],step_px=step,grid=grid)



def save_state(path, state):
    temporary=path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state))
    temporary.replace(path)


def reconstruct(request):
    base=os.environ.get('ERFMAP_NODEODM_URL','http://127.0.0.1:3001').rstrip('/')
    info=api(base,'/info')
    if str(info.get('engine','')).lower()!='odm':raise RuntimeError('The configured NodeODM service is not using the ODM engine.')
    job=Path(request['job'])
    frames=[f for f in request['frames']['frames'] if f.get('usable', True) and not f.get('excluded')]
    paths=[job/f.get('original', f['image']) for f in frames if f.get('image')]
    if len(paths)<3:raise RuntimeError('Reconstruction needs at least three usable overlapping photographs.')
    options=[{'name':'dtm','value':True},{'name':'pc-classify','value':True},
             {'name':'dem-gapfill-steps','value':0}]
    config_path=job/'job.json'
    config=json.loads(config_path.read_text()).get('reconstruction', {}) if config_path.exists() else {}
    if config.get('buildingModel'):
        options.append({'name':'skip-3dmodel','value':False})
    supported={o['name'] for o in api(base,'/options')}
    missing=[o['name'] for o in options if o['name'] not in supported]
    if missing:raise RuntimeError('NodeODM lacks required options: '+', '.join(missing))
    if info.get('maxImages') and len(paths)>info['maxImages']:
        raise RuntimeError('Capture count exceeds NodeODM maxImages: '+str(info['maxImages']))
    digest=hashlib.sha256(json.dumps(options,sort_keys=True).encode())
    for path in paths:
        if not path.is_file():raise RuntimeError('Missing capture: '+str(path))
        digest.update(str(path.relative_to(job)).encode())
        with path.open('rb') as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
    fingerprint=digest.hexdigest()
    state_path=job/'nodeodm-task.json'
    state=json.loads(state_path.read_text()) if state_path.exists() else {}
    reuse=state.get('server')==base and state.get('fingerprint')==fingerprint
    if not reuse or state.get('phase')=='uploading':
        # An interrupted upload is never committed with an incomplete image set.
        fields=urllib.parse.urlencode({'name':'erfmap-'+job.name,'options':json.dumps(options)}).encode()
        uuid=api(base,'/task/new/init',fields)['uuid']
        state={'uuid':uuid,'server':base,'fingerprint':fingerprint,'phase':'uploading',
               'engineVersion':info.get('engineVersion'),'options':options}
        save_state(state_path,state)
        for path in paths:upload(base,uuid,path)
        state['phase']='committing';save_state(state_path,state)
        api(base,'/task/new/commit/'+uuid,b'')
        state['phase']='committed';save_state(state_path,state)
    uuid=state['uuid']
    # /info is the task status endpoint; /task/<uuid> is not an API endpoint.
    task=api(base,'/task/'+uuid+'/info')
    if task['status']['code'] in (30,50):
        api(base,'/task/restart',urllib.parse.urlencode({'uuid':uuid}).encode())
    deadline=time.monotonic()+int(os.environ.get('ERFMAP_NODEODM_TIMEOUT','7200'))
    while time.monotonic()<deadline:
        task=api(base,'/task/'+uuid+'/info');code=task['status']['code']
        if code==40:break
        if code in (30,50):
            output=api(base,'/task/'+uuid+'/output')
            (job/'nodeodm-output.json').write_text(json.dumps(output))
            raise RuntimeError('NodeODM task '+uuid+' failed or was canceled. See nodeodm-output.json; retry after resolving the cause.')
        time.sleep(10)
    else:raise RuntimeError('NodeODM reconstruction timed out; retry reconnects to task '+uuid+'.')
    archive=job/'nodeodm-all.zip'
    with urllib.request.urlopen(base+'/task/'+uuid+'/download/all.zip',timeout=600) as response,archive.open('wb') as output:
        import shutil
        shutil.copyfileobj(response,output)
    with zipfile.ZipFile(archive) as z:
        names=z.namelist()
        def asset(suffix):
            found=[name for name in names if name.lower().endswith(suffix)]
            if not found:raise RuntimeError('NodeODM output is missing '+suffix)
            return found[0]
        dtm=asset('odm_dem/dtm.tif');ortho=asset('odm_orthophoto/odm_orthophoto.tif')
        out=job/'nodeodm-rasters';out.mkdir(exist_ok=True)
        for name,target in [(dtm,'dtm.tif'),(ortho,'orthophoto.tif')]:
            with z.open(name) as source,(out/target).open('wb') as dest:
                import shutil
                shutil.copyfileobj(source,dest)
    return out


def orthophoto_stage(request):
    import rasterio
    from rasterio.enums import Resampling
    out=reconstruct(request)
    job=Path(request['job'])
    with rasterio.open(out/'orthophoto.tif') as src:
        if src.count < 3 or not src.crs or src.crs.is_geographic:
            raise RuntimeError('ODM orthophoto must be RGB with a projected CRS.')
        ratio=min(1,6000/max(src.width,src.height))
        width=max(2,round(src.width*ratio));height=max(2,round(src.height*ratio))
        rgb=src.read([1,2,3],out_shape=(3,height,width),resampling=Resampling.bilinear)
        image=np.moveaxis(rgb,0,2).astype(np.uint8)
        mask=src.dataset_mask(out_shape=(height,width),resampling=Resampling.nearest)
        image[mask==0]=32
        preview=out/'orthophoto.jpg'
        if not cv2.imwrite(str(preview),cv2.cvtColor(image,cv2.COLOR_RGB2BGR)):
            raise RuntimeError('Could not write ODM preview.')
    mosaic={'image':str(preview.relative_to(job)),'width':width,'height':height,'scale':ratio,'source':'NodeODM'}
    frame={'id':'scene','before':mosaic['image'],'after':mosaic['image'],
           'width':width,'height':height,'to_mosaic':np.eye(3).tolist()}
    return {'status':'complete','summary':'ODM orthophoto ready for calibration and labeling',
            'frames':[frame],'mosaic':mosaic,'links':[], 'reference':'scene',
            'lens':{'status':'applied','reason':'ODM camera calibration and orthorectification'},
            'cleanup':'ODM orthophoto',
            'reconstructionArchive':str((job/'nodeodm-all.zip').relative_to(job)),
            'warnings':['Confirm a measured ground distance on this orthophoto. Terrain uses local relative heights; vertical control and accuracy still require verification.',
                        'DTM gap filling is disabled. Ground filtering and rasterization still estimate the ground surface.']}


def run(request):
    if request['mosaic'].get('source')=='NodeODM':
        out=Path(request['job'])/'nodeodm-rasters'
    else:
        out=reconstruct(request)
    return terrain_from_rasters(out/'dtm.tif',out/'orthophoto.tif',request)


if __name__=='__main__':
    try:print(json.dumps(run(json.load(sys.stdin))))
    except Exception as exc:
        print(str(exc),file=sys.stderr);sys.exit(1)

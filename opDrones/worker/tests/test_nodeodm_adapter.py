import json
import io
import zipfile
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import rasterio
from rasterio.transform import from_origin
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from nodeodm_adapter import register, terrain_from_rasters, reconstruct, orthophoto_stage

class NodeODMAdapterTests(unittest.TestCase):
    def test_register_and_scale_dtm_to_measured_distance(self):
        rng=np.random.default_rng(123)
        image=rng.integers(30,225,size=(400,400,3),dtype=np.uint8)
        for i in range(80):
            p=(int(rng.integers(15,385)),int(rng.integers(15,385)))
            cv2.circle(image,p,int(rng.integers(2,7)),(255,255,255),-1)
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder)
            cv2.imwrite(str(folder/'mosaic.jpg'),image)
            transform=from_origin(1000,2000,2,2)
            with rasterio.open(folder/'ortho.tif','w',driver='GTiff',height=400,width=400,count=3,dtype='uint8',crs='EPSG:32618',transform=transform) as dst:
                for band in range(3):dst.write(image[:,:,band],band+1)
            terrain=np.float32(np.tile(np.arange(400)*.02,(400,1)))
            with rasterio.open(folder/'dtm.tif','w',driver='GTiff',height=400,width=400,count=1,dtype='float32',crs='EPSG:32618',transform=transform) as dst:dst.write(terrain,1)
            request={'job':str(folder),'mosaic':{'image':'mosaic.jpg','width':400,'height':400},'scale':{'m_per_px':.1}}
            result=terrain_from_rasters(folder/'dtm.tif',folder/'ortho.tif',request)
            self.assertGreater(len(result['grid']),10)
            self.assertAlmostEqual(result['grid'][50][50]-result['grid'][50][49],result['step_px'][0]*.001,delta=.03)
            self.assertTrue(result['ground_filtered'])

    def test_retry_reuses_completed_task_and_changed_images_create_new_task(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder)
            for i in range(3):(folder/('%s.jpg'%i)).write_bytes(bytes([i]))
            request={'job':str(folder),'frames':{'frames':[{'image':'%s.jpg'%i,'usable':True} for i in range(3)]}}
            archive=io.BytesIO()
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('odm_dem/dtm.tif',b'dtm')
                z.writestr('odm_orthophoto/odm_orthophoto.tif',b'ortho')
            calls=[]
            def api(base,endpoint,payload=None):
                calls.append(endpoint)
                if endpoint=='/info':return {'engine':'odm','engineVersion':'test','maxImages':5}
                if endpoint=='/options':return [{'name':n} for n in ('dtm','pc-classify','dem-gapfill-steps','skip-3dmodel')]
                if endpoint=='/task/new/init':return {'uuid':'test-task'}
                if endpoint.endswith('/info'):return {'status':{'code':40}}
                return {'success':True}
            with patch('nodeodm_adapter.api',side_effect=api), patch('nodeodm_adapter.upload') as upload, patch('nodeodm_adapter.urllib.request.urlopen',side_effect=lambda *a,**k:io.BytesIO(archive.getvalue())):
                reconstruct(request)
                reconstruct(request)
                self.assertEqual(calls.count('/task/new/init'),1)
                self.assertEqual(upload.call_count,3)
                self.assertIn('/task/test-task/info',calls)
                # A failed server task is restarted under the same UUID.
                original_api=api
                failed_once=[True]
                def failed_api(base, endpoint, payload=None):
                    if endpoint.startswith('/task/') and endpoint.endswith('/info') and failed_once[0]:
                        failed_once[0]=False
                        return {'status':{'code':30}}
                    return original_api(base,endpoint,payload)
                with patch('nodeodm_adapter.api',side_effect=failed_api):
                    reconstruct(request)
                self.assertIn('/task/restart',calls)
                self.assertEqual(calls.count('/task/new/init'),1)
                (folder/'0.jpg').write_bytes(b'changed')
                reconstruct(request)
                self.assertEqual(calls.count('/task/new/init'),2)
                (folder/'job.json').write_text(json.dumps({'reconstruction':{'enabled':True,'buildingModel':True}}))
                reconstruct(request)
                self.assertEqual(calls.count('/task/new/init'),3)
            state=json.loads((folder/'nodeodm-task.json').read_text())
            self.assertIn({'name':'dem-gapfill-steps','value':0},state['options'])
            self.assertIn({'name':'skip-3dmodel','value':False},state['options'])

    def test_orthophoto_terrain_uses_pixel_transform_and_preserves_nodata(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder);out=folder/'nodeodm-rasters';out.mkdir()
            transform=from_origin(1000,2000,2,2)
            with rasterio.open(out/'orthophoto.tif','w',driver='GTiff',height=40,width=40,count=3,dtype='uint8',crs='EPSG:32618',transform=transform) as dst:
                dst.write(np.full((3,40,40),100,np.uint8))
            ground=np.ones((40,40),np.float32);ground[:10,:10]=-9999
            with rasterio.open(out/'dtm.tif','w',driver='GTiff',height=40,width=40,count=1,dtype='float32',nodata=-9999,crs='EPSG:32618',transform=transform) as dst:dst.write(ground,1)
            with patch('nodeodm_adapter.reconstruct',return_value=out):
                stage=orthophoto_stage({'job':str(folder)})
            request={'job':str(folder),'mosaic':stage['mosaic'],'scale':{'m_per_px':2}}
            with patch('nodeodm_adapter.register',side_effect=AssertionError('must not register')):
                result=terrain_from_rasters(out/'dtm.tif',out/'orthophoto.tif',request)
            self.assertIsNone(result['grid'][0][0])
            self.assertEqual(result['grid'][20][20],1)
            self.assertEqual(stage['frames'][0]['id'],'scene')

    def test_reject_ambiguous_image_registration(self):
        a=np.zeros((200,200,3),np.uint8)
        with self.assertRaisesRegex(RuntimeError,'No image features'):
            register(a,a)

if __name__=='__main__':unittest.main()

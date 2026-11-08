import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from train_semantic import rasterize, validate
from PIL import Image


class TrainingTests(unittest.TestCase):
    def test_sparse_mask_preserves_unknown_and_all_tools(self):
        image = Image.new('RGB', (100,100))
        shapes = [
            {'type':'box','category_id':1,'points':[[20,20],[10,10]]},
            {'type':'polygon','category_id':2,'points':[[30,30],[40,30],[35,40]]},
            {'type':'polyline','category_id':3,'points':[[50,50],[80,50]]},
            {'type':'point','category_id':4,'points':[[80,80]]},
        ]
        mask = rasterize(image, shapes, {1:0,2:1,3:2,4:3}, image.size)
        for point, expected in [((0,0),255),((15,15),0),((35,32),1),((60,50),2),((80,80),3)]:
            self.assertEqual(mask.getpixel(point), expected)

    def test_bush_training_and_classifier_mapping(self):
        from adapters.clip_zones import map_labels, SYNONYMS, POINT_SYNONYMS, POINTS
        from adapters.clip_classifier import PROMPTS
        dataset = {'format':'erfmap-semantic-annotations','version':1,
                   'categories':[{'id':6,'name':'bush'}],
                   'images':[{'id':'x','width':100,'height':100}],
                   'annotations':[{'image_id':'x','category_id':6,'type':'point','points':[[50,50]]}]}
        categories, images, grouped = validate(dataset)
        self.assertEqual(categories[6], 'bush')
        mapping = map_labels({0:'grass', 1:'plant, flora, plant life', 2:'tree', 3:'shrub'}, {**SYNONYMS, **POINT_SYNONYMS})
        self.assertEqual(mapping['bush'], [1,3])
        self.assertEqual(mapping['grass'], [0])
        self.assertEqual(mapping['tree'], [2])
        self.assertIn('bush', POINTS)
        self.assertIn('bush', PROMPTS)
        mask = rasterize(Image.new('RGB', (100,100)), grouped['x'], {6:1}, (100,100))
        self.assertEqual(mask.getpixel((50,50)), 1)

    def test_road_and_grass_surface_training(self):
        dataset = {'format':'erfmap-semantic-annotations','version':1,
                   'categories':[{'id':7,'name':'road'},{'id':8,'name':'grass'}],
                   'images':[{'id':'x','width':100,'height':100}],
                   'annotations':[
                       {'image_id':'x','category_id':7,'type':'polygon','points':[[0,0],[40,0],[40,100],[0,100]]},
                       {'image_id':'x','category_id':8,'type':'polygon','points':[[60,0],[100,0],[100,100],[60,100]]}]}
        categories, images, grouped = validate(dataset)
        self.assertEqual(categories, {7:'road',8:'grass'})
        mask = rasterize(Image.new('RGB',(100,100)), grouped['x'], {7:6,8:9}, (100,100))
        self.assertEqual(mask.getpixel((20,50)),6)
        self.assertEqual(mask.getpixel((80,50)),9)
        self.assertEqual(mask.getpixel((50,50)),255)

    def test_rejects_outside_annotation(self):
        dataset = {'format':'erfmap-semantic-annotations','version':1,'categories':[{'id':1,'name':'path'}], 'images':[{'id':'x','width':100,'height':100}], 'annotations':[{'image_id':'x','category_id':1,'type':'point','points':[[101,0]]}]}
        with self.assertRaises(ValueError):
            validate(dataset)


if __name__ == '__main__':
    unittest.main()

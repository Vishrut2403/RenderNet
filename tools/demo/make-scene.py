import bpy, math, os

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 960
scene.render.resolution_y = 540
scene.render.film_transparent = False
scene.frame_start = 1
scene.frame_end = 24

def material(name, colour, roughness=0.4, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = colour
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    return mat

bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
bpy.context.object.data.materials.append(material('Floor', (0.22, 0.22, 0.24, 1), 0.7))

bpy.ops.mesh.primitive_uv_sphere_add(radius=1.1, location=(-1.9, 0.4, 1.1))
bpy.ops.object.shade_smooth()
bpy.context.object.data.materials.append(material('Steel', (0.44, 0.61, 0.76, 1), 0.25, 0.9))

bpy.ops.mesh.primitive_cube_add(size=1.8, location=(0.9, -0.6, 0.9), rotation=(0, 0, 0.5))
bpy.context.object.data.materials.append(material('Clay', (0.78, 0.42, 0.29, 1), 0.55))

bpy.ops.mesh.primitive_torus_add(major_radius=0.85, minor_radius=0.28,
                                 location=(2.6, 1.5, 0.75), rotation=(1.2, 0, 0.4))
bpy.ops.object.shade_smooth()
bpy.context.object.data.materials.append(material('Brass', (0.83, 0.68, 0.32, 1), 0.3, 0.8))

light = bpy.data.lights.new('Key', type='AREA')
light.energy = 900
light.size = 6
key = bpy.data.objects.new('Key', light)
key.location = (-4, -5, 7)
key.rotation_euler = (0.7, -0.3, -0.6)
scene.collection.objects.link(key)

fill = bpy.data.lights.new('Fill', type='AREA')
fill.energy = 220
fill.size = 8
obj = bpy.data.objects.new('Fill', fill)
obj.location = (6, 4, 4)
obj.rotation_euler = (1.1, 0.2, 2.2)
scene.collection.objects.link(obj)

world = bpy.data.worlds.new('World')
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.06, 0.08, 1)
scene.world = world

camera_data = bpy.data.cameras.new('Camera')
camera_data.lens = 42
camera = bpy.data.objects.new('Camera', camera_data)
camera.location = (7.2, -7.6, 4.4)
camera.rotation_euler = (1.15, 0, 0.76)
scene.collection.objects.link(camera)
scene.camera = camera

# The turntable is what makes a 24-frame job look like an animation.
for obj in bpy.data.objects:
    if obj.type == 'MESH' and obj.name != 'Plane':
        obj.rotation_mode = 'XYZ'
        obj.keyframe_insert('rotation_euler', frame=1)
        obj.rotation_euler[2] += math.radians(120)
        obj.keyframe_insert('rotation_euler', frame=24)

bpy.ops.wm.save_as_mainfile(filepath=os.environ['DEMO_BLEND'])

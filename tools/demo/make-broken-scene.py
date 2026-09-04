import bpy, os

bpy.ops.wm.open_mainfile(filepath=os.environ['DEMO_BLEND'])

# An image the scene reaches for and does not carry, which is what the check
# before queueing is meant to catch.
material = bpy.data.materials['Clay']
nodes = material.node_tree.nodes
texture = nodes.new('ShaderNodeTexImage')
image = bpy.data.images.new('concrete_diffuse', width=8, height=8)
image.filepath = '//textures/concrete_diffuse.png'
image.source = 'FILE'
texture.image = image
material.node_tree.links.new(texture.outputs['Color'],
                             nodes['Principled BSDF'].inputs['Base Color'])

bpy.ops.wm.save_as_mainfile(filepath=os.environ['DEMO_BROKEN'])

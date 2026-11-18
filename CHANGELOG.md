# Changelog

## 2.0.0

### New: Paint a model
- Load your own STL or 3MF and paint the art onto it. The shape is left alone; the art is saved as Orca color painting on your filament slots, so it slices like hand painting and can be touched up with Orca's color painting tool.
- **Straight on** projects the art onto one side: front, back, left, right, top, or the direction the 3D view is facing.
- **Wrap around** wraps the art round mugs, cups, cans and vases like a label. It fits the round body (ignoring handles and spouts) and is chosen automatically for round models.
- Model scale (%) or an exact height, and the art keeps its place as the model grows or shrinks.
- **Lay on face**, like the slicer's: press it and click a face in the 3D view, and the model turns so that face sits flat on the plate. *Reset orientation* puts it back as loaded.
- Art width, position, rotation, turn around the model, the steepest surface to paint, and the finest detail.
- Anything hidden behind another part of the model stays unpainted.
- Drop an STL or 3MF on the image box and it opens in Paint a model.
- Adding an image only adds the art's colors; the model keeps its own filament (light grey until you pick one).
- **Text only**: paint just a name or message (straight, or curved along the top or bottom) without any image. Set its size with the text width.
- **Click to place**: press *Click the model to place the art*, then click the spot in the 3D view. Straight on, the art is painted facing that surface; wrapped, the click sets how far round and how high it sits.

### Other changes
- One version number everywhere: the web app (shown next to the title), the OrcaSlicer plugin and the Windows app are all 2.0.0.

## 1.8.1
- The minimum line width no longer puts round knobs on the corners and ends of letters.

## 1.8.0
- Joystick dust cover generator: 41.5 mm disc with a 9 mm center hole, 1 mm thick, printed face down. Thickness can go down to 0.6 mm.

## 1.7.3
- Small prints (keychains, flat models) keep fine details such as eyes and claws instead of merging them into the outline.

## 1.7.2
- Every piece of the art is kept, not only the largest; tiny images are enlarged cleanly.
- New icon: a picture turning into a layered multicolor print.

## 1.7.0
- First public release: trinket tray, coin & token, keychain, magnet, coaster, bookmark, cookie cutter and flat model generators; OrcaSlicer plugin; Windows app.

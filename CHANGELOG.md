# Changelog

## 2.0.1

### New
- **Through the base** (flat generators: keychain, magnet, coaster, bookmark, flat model, dust cover): tick it on a color and the body under that color is printed in that color all the way down, so a tree's trunk can be brown, its branches green and its star yellow right through. Small details on top (ornaments) take the color around them underneath, and everything else keeps the base filament. It shows when the color depth is less than the thickness.

### Fixed
- Raising *Smooth edges* no longer pulls the colors in from the edge, which left a lower ledge of the base showing around the outside.
- No more slivers of base filament where two colors meet at the outline (a star's points on a tree top, for example); small notches closed by *Fill gaps* between two colors take the color beside them.

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
- Text added to the art never resizes or moves the picture: *Art width* is the picture's own width, and the picture stays centred where you put it while the text grows or shrinks beside it.
- **Text only**: paint just a name or message (straight, or curved along the top or bottom) without any image. Set its size with the text width.
- **Click to place**: press *Click the model to place the art*, then click the spot in the 3D view. Straight on, the art is painted facing that surface, upright as the 3D view shows it, so *Move art up* and *sideways* follow the screen; wrapped, the click sets how far round and how high it sits.

### Other changes
- Undo and redo cover *Lay on face* and *Click to place*.
- OrcaSlicer plugin: the generator page is stored as plain, readable text instead of a compressed blob, and unused link-opening code is gone.
- Text can now go to the **right** or **left** of the art, centred on its height, in every generator.
- Colors that share a name get told apart by shade: *Blue (darker)* and *Blue (lighter)*, or numbered darkest to lightest when there are more, in the color list and the filament slots.
- Tested on a 1-million-triangle model: paints in about 20 seconds and sends to Orca with the painting intact.
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

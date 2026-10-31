`plugin_template.py` is the OrcaSlicer 2.5 plugin. `tools/build.py plugin` embeds the built page (compressed) where `__PAGE_DATA__` sits and writes `dist/maker_generators_orca_plugin.py`.

Orca's plugin API cannot add objects to the plate, so **Send to plate** writes the 3MF to the plugin's storage folder and hands it to the running Orca with the same message a second launch sends (WM_COPYDATA on Windows, `open -a` on macOS, D-Bus on Linux).

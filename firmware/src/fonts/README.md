# Display fonts

Anti-aliased TFT_eSPI smooth fonts (VLW) generated from **Inter** (Regular and
SemiBold) by `firmware/tools/make_vlw.swift` (macOS CoreText). Inter is
© The Inter Project Authors, licensed under the SIL Open Font License 1.1
(`OFL.txt`). The files here are a format conversion (a Modified Version) and are
distributed under the same license.

| File | Size | Characters |
| --- | --- | --- |
| `inter_semibold_44.h`, `_30.h`, `_22.h` | 44, 30, 22 px | ASCII (numbers and short labels) |
| `inter_semibold_14.h`, `inter_regular_15.h`, `inter_regular_12.h` | 14, 15, 12 px | ASCII, Latin-1, Latin Extended-A (incl. Czech) and common punctuation |

Characters a font lacks are drawn as `?`. To regenerate (sizes as in the table):

```sh
swift firmware/tools/make_vlw.swift Inter-Regular.otf 15 latin kFontText firmware/src/fonts/inter_regular_15.h
```

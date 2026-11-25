// Renders the TokenBeacon screens (Overview, Limits, Context, Info) in
// portrait 170x320 or landscape 320x170 from the display model.
#pragma once

#include <TFT_eSPI.h>

#include "tb_model.h"

namespace ui {

enum class Screen : uint8_t { Overview, Limits, Context, Info };
constexpr uint8_t kScreenCount = 4;

struct Frame {
  Screen screen = Screen::Overview;
  bool landscape = false;
  bool hostConnected = false;  // the host has the port open and said hello
  const char* firmware = "";
};

/** Sets the orientation, allocates the frame buffer (PSRAM) and clears the screen. */
void begin(TFT_eSPI& tft, bool landscape);

/** Switches orientation; the next render draws in the new layout. */
void setOrientation(TFT_eSPI& tft, bool landscape);

/** Draws one frame. */
void render(TFT_eSPI& tft, const tb::DisplayModel& model, uint32_t nowMs, const Frame& frame);

}  // namespace ui

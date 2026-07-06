"use strict";

/* ==========================================================================
   BENCHMARK PANEL — Redirect Wrapper
   Eski overlay modal kaldırıldı.
   Artık /benchmark sayfasına yönlendirme yapılıyor.
   ========================================================================== */

function openBenchmarkPanel() {
  window.location.href = "/benchmark";
}

function closeBenchmarkPanel() {
  // Artık kullanılmıyor — uyumluluk için bırakıldı
}

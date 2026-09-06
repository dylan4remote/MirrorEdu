// Drives the login page's loading-sequence overlay defined in index.html /
// styles.css. The animation timing lives in CSS; this just tears the
// overlay down once it's done (or immediately on click, or for anyone who
// prefers reduced motion).
(function () {
  const intro = document.getElementById('intro');
  if (!intro) return;

  function finishIntro() {
    intro.classList.add('intro-done');
    setTimeout(() => intro.remove(), 700);
  }

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finishIntro();
    return;
  }

  intro.addEventListener('click', finishIntro);
  setTimeout(finishIntro, 1500);
})();

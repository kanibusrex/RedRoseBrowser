'use strict';

// Back/forward/reload-stop buttons + loading progress bar.

export function createToolbar(
  { backBtn, forwardBtn, reloadBtn, homeBtn, progressBar },
  { onBack, onForward, onReload, onStop, onHome }
) {
  let isLoading = false;

  backBtn.addEventListener('click', () => onBack());
  forwardBtn.addEventListener('click', () => onForward());
  reloadBtn.addEventListener('click', () => {
    if (isLoading) onStop();
    else onReload();
  });
  homeBtn.addEventListener('click', () => onHome());

  function render(tab) {
    if (!tab) {
      backBtn.disabled = true;
      forwardBtn.disabled = true;
      reloadBtn.textContent = '↻';
      reloadBtn.title = 'Reload';
      progressBar.classList.remove('loading');
      return;
    }

    backBtn.disabled = !tab.canGoBack;
    forwardBtn.disabled = !tab.canGoForward;

    isLoading = tab.isLoading;
    if (isLoading) {
      reloadBtn.textContent = '×';
      reloadBtn.title = 'Stop';
      progressBar.classList.add('loading');
    } else {
      reloadBtn.textContent = '↻';
      reloadBtn.title = 'Reload';
      progressBar.classList.remove('loading');
    }
  }

  return { render };
}

// An `Export` module as the program frame imports it (D16): `mount(root,
// { theme, args })`. It writes what it was given into the root it was handed,
// so a test reads the theme and the args the frame passed.

export function mount(
  root: HTMLElement,
  options: { readonly theme: 'light' | 'dark'; readonly args?: unknown },
): () => void {
  const document = root.ownerDocument;
  const shown = document.createElement('output');
  shown.className = 'export-mounted';
  shown.setAttribute('data-theme', options.theme);
  shown.setAttribute('data-args', JSON.stringify(options.args ?? null));
  shown.textContent = 'exported';
  root.append(shown);

  return () => shown.remove();
}

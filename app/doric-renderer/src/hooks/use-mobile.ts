import * as React from 'react';

const mobileBreakpoint = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>();

  React.useEffect(() => {
    const media = window.matchMedia(`(max-width: ${mobileBreakpoint - 1}px)`);
    const update = () => setIsMobile(window.innerWidth < mobileBreakpoint);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);

  return Boolean(isMobile);
}

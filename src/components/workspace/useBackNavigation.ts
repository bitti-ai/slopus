import { useEffect, useRef } from "react";

export interface BackNavigation { label: string; run: () => void }
export type BackNavigationChange = (navigation: BackNavigation | null) => void;

/** A mounted view temporarily supplies the application back button's action. */
export function useBackNavigation(onChange: BackNavigationChange | undefined, label: string | null, run: () => void) {
  const action = useRef(run);
  action.current = run;
  useEffect(() => {
    onChange?.(label ? { label, run: () => action.current() } : null);
    return () => onChange?.(null);
  }, [onChange, label]);
}

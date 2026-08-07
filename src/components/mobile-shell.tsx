import type { ReactNode } from "react";
import { BottomNav } from "@/components/bottom-nav";
import styles from "./mobile-shell.module.css";

type MobileShellProps = {
  children: ReactNode;
  showNavigation?: boolean;
};

export function MobileShell({ children, showNavigation = true }: MobileShellProps) {
  return (
    <div className={styles.viewport}>
      <main className={styles.shell}>{children}</main>
      {showNavigation && <BottomNav />}
    </div>
  );
}

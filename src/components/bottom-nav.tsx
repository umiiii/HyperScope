"use client";

import { Binoculars, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./mobile-shell.module.css";

export function BottomNav() {
  const pathname = usePathname();
  const onDashboard =
    pathname === "/" ||
    (pathname.startsWith("/addresses/") && pathname !== "/addresses/new");
  const onAdd = pathname === "/addresses/new";

  return (
    <nav className={styles.bottomNav} aria-label="主要导航">
      <Link className={onDashboard ? styles.activeNavItem : styles.navItem} href="/">
        <Binoculars size={21} aria-hidden="true" />
        <span>监视</span>
      </Link>
      <Link className={onAdd ? styles.activeNavItem : styles.navItem} href="/addresses/new">
        <Plus size={22} aria-hidden="true" />
        <span>添加</span>
      </Link>
    </nav>
  );
}

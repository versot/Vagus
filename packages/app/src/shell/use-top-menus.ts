import { useEffect, useRef, useState } from "react";




export function useTopMenus() {
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [editMenuOpen, setEditMenuOpen] = useState(false);
  const editMenuTargetRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const [viewBrowserSubmenuOpen, setViewBrowserSubmenuOpen] = useState(false);
  const menuSwitchedByHoverRef = useRef<"file" | "edit" | "view" | "help" | null>(null);
  const anyTopMenuOpen = fileMenuOpen || editMenuOpen || viewMenuOpen || helpMenuOpen;
  const setTopMenu = (menu: "file" | "edit" | "view" | "help", toggle = false) => {
    const currentlyOpen = menu === "file" ? fileMenuOpen : menu === "edit" ? editMenuOpen : menu === "view" ? viewMenuOpen : helpMenuOpen;
    const shouldOpen = toggle ? !currentlyOpen : true;
    setFileMenuOpen(menu === "file" && shouldOpen);
    setEditMenuOpen(menu === "edit" && shouldOpen);
    setViewMenuOpen(menu === "view" && shouldOpen);
    setHelpMenuOpen(menu === "help" && shouldOpen);
  };
  const hoverTopMenu = (menu: "file" | "edit" | "view" | "help") => {
    if (anyTopMenuOpen) { setTopMenu(menu); menuSwitchedByHoverRef.current = menu; }
  };
  const clickTopMenu = (menu: "file" | "edit" | "view" | "help") => {
    if (menuSwitchedByHoverRef.current === menu) { menuSwitchedByHoverRef.current = null; return; }
    menuSwitchedByHoverRef.current = null;
    setTopMenu(menu, true);
  };
  const closeTopMenus = () => { setFileMenuOpen(false); setEditMenuOpen(false); setViewMenuOpen(false); setHelpMenuOpen(false); };
  useEffect(() => { if (!viewMenuOpen) setViewBrowserSubmenuOpen(false); }, [viewMenuOpen]);
  return { fileMenuOpen, setFileMenuOpen, editMenuOpen, setEditMenuOpen, editMenuTargetRef, viewMenuOpen, setViewMenuOpen, helpMenuOpen, setHelpMenuOpen, viewBrowserSubmenuOpen, setViewBrowserSubmenuOpen, anyTopMenuOpen, hoverTopMenu, clickTopMenu, closeTopMenus };
}

import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { useRef, useState } from "react";

export function useTerminalSearch(terminalRef: React.MutableRefObject<Terminal | null>) {
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [showSearchBar, setShowSearchBar] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const handleSearchNext = () => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findNext(searchQuery);
    }
  };

  const handleSearchPrev = () => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findPrevious(searchQuery);
    }
  };

  const handleCloseSearch = () => {
    setShowSearchBar(false);
    setSearchQuery("");
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.focus();
  };

  return {
    searchAddonRef,
    showSearchBar,
    setShowSearchBar,
    searchQuery,
    setSearchQuery,
    handleSearchNext,
    handleSearchPrev,
    handleCloseSearch,
  };
}

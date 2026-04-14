import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MdChevronRight, MdClose, MdExpandMore, MdSettings } from "react-icons/md";
import { ConnectionCombobox, type ConnectionOption } from "@/components/dialog/network/shared";
import { KeyManagementTab } from "@/components/panel/security-auth/KeyManagementTab";
import { PasswordManagementTab } from "@/components/panel/security-auth/PasswordManagementTab";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { OtpEntry, ProxyConfig, SavedPassword, SshKey } from "@/types/global";

interface SshFormProps {
  host: string;
  setHost: (v: string) => void;
  port: number;
  setPort: (v: number) => void;
  username: string;
  setUsername: (v: string) => void;
  authType: "password" | "key";
  setAuthType: (v: "password" | "key") => void;
  passwordId: string;
  setPasswordId: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  hasPassword: boolean;
  setHasPassword: (v: boolean) => void;
  keyId: string;
  setKeyId: (v: string) => void;
  proxyId: string;
  setProxyId: (v: string) => void;
  proxies: ProxyConfig[];
  jumpHostId: string;
  setJumpHostId: (v: string) => void;
  jumpHostOptions: ConnectionOption[];
  otpId: string;
  setOtpId: (v: string) => void;
  autoFillOtp: boolean;
  setAutoFillOtp: (v: boolean) => void;
  otpEntries: OtpEntry[];
}

export function SshForm({
  host,
  setHost,
  port,
  setPort,
  username,
  setUsername,
  authType,
  setAuthType,
  passwordId,
  setPasswordId,
  password,
  setPassword,
  hasPassword,
  setHasPassword,
  keyId,
  setKeyId,
  proxyId,
  setProxyId,
  proxies,
  jumpHostId,
  setJumpHostId,
  jumpHostOptions,
  otpId,
  setOtpId,
  autoFillOtp,
  setAutoFillOtp,
  otpEntries,
}: SshFormProps) {
  const { t } = useTranslation();
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [savedPasswords, setSavedPasswords] = useState<SavedPassword[]>([]);
  const [showKeyDropdown, setShowKeyDropdown] = useState(false);
  const [showPasswordDropdown, setShowPasswordDropdown] = useState(false);
  const [showKeyManagement, setShowKeyManagement] = useState(false);
  const [showPasswordManagement, setShowPasswordManagement] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const keyRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLDivElement>(null);

  const loadSshKeys = useCallback(async () => {
    try {
      const keys = await invoke<SshKey[]>("get_ssh_keys");
      setSshKeys(keys);
      if (keyId && !keys.some((key) => key.id === keyId)) {
        setKeyId("");
      }
    } catch {
      /* ignore */
    }
  }, [keyId, setKeyId]);

  const loadPasswords = useCallback(async () => {
    try {
      const passwords = await invoke<SavedPassword[]>("get_saved_passwords");
      setSavedPasswords(passwords);
      if (passwordId && !passwords.some((p) => p.id === passwordId)) {
        setPasswordId("");
      }
    } catch {
      /* ignore */
    }
  }, [passwordId, setPasswordId]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (keyRef.current && !keyRef.current.contains(e.target as Node)) {
        setShowKeyDropdown(false);
      }
      if (passwordRef.current && !passwordRef.current.contains(e.target as Node)) {
        setShowPasswordDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    let unlisten: () => void;
    getCurrentWindow()
      .onFocusChanged((event) => {
        if (event.payload) {
          void loadSshKeys();
          void loadPasswords();
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    void loadSshKeys();
    void loadPasswords();
    return () => {
      if (unlisten) unlisten();
    };
  }, [loadSshKeys, loadPasswords]);

  const selectedKeyName = sshKeys.find((k) => k.id === keyId)?.name;
  const selectedPasswordName = savedPasswords.find((p) => p.id === passwordId)?.name;
  const selectedProxyName = proxies.find((proxy) => proxy.id === proxyId)?.name;
  const selectedJumpHost = jumpHostOptions.find((option) => option.connection.id === jumpHostId);
  const selectedOtpLabel = otpEntries.find((entry) => entry.id === otpId);
  const advancedSummary = [
    proxyId ? (selectedProxyName ?? t("dialog.proxySelect")) : t("dialog.noProxy"),
    jumpHostId
      ? (selectedJumpHost?.connection.name ?? t("dialog.selectProxyJump"))
      : t("dialog.noProxyJump"),
    otpId
      ? selectedOtpLabel
        ? `${selectedOtpLabel.issuer} (${selectedOtpLabel.username})`
        : t("dialog.selectOtp")
      : t("dialog.noOtp"),
  ].join(" · ");

  return (
    <div className="space-y-4 w-full">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="min-w-0 flex-1">
          <Label className="text-[0.6875rem] text-muted-foreground">{t("dialog.host")}</Label>
          <Input
            className="mt-1 text-xs h-8"
            placeholder="192.168.1.100"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-32">
          <Label className="text-[0.6875rem] text-muted-foreground">{t("dialog.port")}</Label>
          <NumberInput
            className="mt-1 [&_button]:h-8 [&_button]:w-8 [&_input]:h-8 [&_input]:text-xs"
            value={port}
            onChange={setPort}
            min={1}
            max={65535}
          />
        </div>
      </div>
      <div>
        <Label className="text-[0.6875rem] text-muted-foreground">{t("dialog.username")}</Label>
        <Input
          className="mt-1 text-xs h-8"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <div>
        <Label className="text-[0.6875rem] text-muted-foreground">
          {t("dialog.authentication")}
        </Label>
        <Tabs
          value={authType}
          onValueChange={(v) => setAuthType(v as "password" | "key")}
          className="w-full mt-1"
        >
          <TabsList className="grid w-full grid-cols-2 h-8 pointer-events-auto">
            <TabsTrigger value="password" className="text-xs">
              {t("dialog.password")}
            </TabsTrigger>
            <TabsTrigger value="key" className="text-xs">
              {t("dialog.privateKey")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="password" className="mt-3 border-0 outline-none space-y-3">
            <div>
              <Label className="text-[0.6875rem] text-muted-foreground">
                {t("dialog.inputPassword")}
              </Label>
              <div className="relative mt-1">
                <Input
                  type="password"
                  className="text-xs h-8 pr-8"
                  placeholder={
                    hasPassword && !password
                      ? t("dialog.passwordAlreadySet")
                      : t("dialog.passwordPlaceholder")
                  }
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (e.target.value) {
                      setPasswordId("");
                      setHasPassword(false);
                    }
                  }}
                />
                {(password || hasPassword) && (
                  <button
                    type="button"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => {
                      setPassword("");
                      setHasPassword(false);
                    }}
                  >
                    <MdClose className="text-sm" />
                  </button>
                )}
              </div>
            </div>
            <div className="relative" ref={passwordRef}>
              <Label className="text-[0.6875rem] text-muted-foreground">
                {t("dialog.selectPassword")}
              </Label>
              <Button
                type="button"
                variant="outline"
                className="w-full mt-1 h-8 justify-between text-xs font-normal"
                onClick={() => setShowPasswordDropdown(!showPasswordDropdown)}
              >
                <span className={`truncate ${passwordId ? "" : "text-muted-foreground"}`}>
                  {selectedPasswordName || t("dialog.selectPassword")}
                </span>
                <MdExpandMore className="text-xs text-muted-foreground shrink-0" />
              </Button>
              {showPasswordDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 border rounded-md shadow-xl z-20 overflow-hidden bg-popover flex flex-col max-h-36">
                  <div className="overflow-y-auto overflow-x-hidden flex-1">
                    <div
                      className={`px-3 py-1.5 text-xs cursor-pointer transition-colors hover:bg-accent ${!passwordId ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}
                      onClick={() => {
                        setPasswordId("");
                        setShowPasswordDropdown(false);
                      }}
                    >
                      {t("dialog.none")}
                    </div>
                    {savedPasswords.map((p) => (
                      <div
                        key={p.id}
                        className={`px-3 py-1.5 text-xs cursor-pointer transition-colors hover:bg-accent ${passwordId === p.id ? "bg-primary/15 text-primary" : ""}`}
                        onClick={() => {
                          setPasswordId(p.id);
                          setPassword("");
                          setShowPasswordDropdown(false);
                        }}
                      >
                        {p.name}
                      </div>
                    ))}
                    {savedPasswords.length === 0 && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        {t("dialog.noPasswords")}
                      </div>
                    )}
                  </div>
                  <div
                    className="px-3 py-1.5 text-xs cursor-pointer transition-colors hover:bg-accent text-primary border-t flex items-center gap-1.5 shrink-0 bg-popover"
                    onClick={() => {
                      setShowPasswordDropdown(false);
                      setShowPasswordManagement(true);
                    }}
                  >
                    <MdSettings className="text-sm" />
                    {t("dialog.managePasswords")}
                  </div>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="key" className="mt-3 border-0 outline-none">
            <div className="relative" ref={keyRef}>
              <Label className="text-[0.6875rem] text-muted-foreground">
                {t("dialog.privateKey")}
              </Label>
              <Button
                type="button"
                variant="outline"
                className="w-full mt-1 h-8 justify-between text-xs font-normal"
                onClick={() => setShowKeyDropdown(!showKeyDropdown)}
              >
                <span className={`truncate ${keyId ? "" : "text-muted-foreground"}`}>
                  {selectedKeyName || t("dialog.selectKey")}
                </span>
                <MdExpandMore className="text-xs text-muted-foreground shrink-0" />
              </Button>
              {showKeyDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 border rounded-md shadow-xl z-20 overflow-hidden bg-popover flex flex-col max-h-36">
                  <div className="overflow-y-auto overflow-x-hidden flex-1">
                    <div
                      className={`px-3 py-1.5 text-xs cursor-pointer transition-colors hover:bg-accent ${!keyId ? "bg-primary/15 text-primary" : "text-muted-foreground"}`}
                      onClick={() => {
                        setKeyId("");
                        setShowKeyDropdown(false);
                      }}
                    >
                      {t("dialog.none")}
                    </div>
                    {sshKeys.map((k) => (
                      <div
                        key={k.id}
                        className={`px-3 py-1.5 text-xs cursor-pointer transition-colors hover:bg-accent ${keyId === k.id ? "bg-primary/15 text-primary" : ""}`}
                        onClick={() => {
                          setKeyId(k.id);
                          setShowKeyDropdown(false);
                        }}
                      >
                        {k.name}
                      </div>
                    ))}
                    {sshKeys.length === 0 && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        {t("dialog.noKeys")}
                      </div>
                    )}
                  </div>
                  <div
                    className="px-3 py-1.5 text-xs cursor-pointer transition-colors hover:bg-accent text-primary border-t flex items-center gap-1.5 shrink-0 bg-popover"
                    onClick={() => {
                      setShowKeyDropdown(false);
                      setShowKeyManagement(true);
                    }}
                  >
                    <MdSettings className="text-sm" />
                    {t("dialog.manageKeys")}
                  </div>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <MdChevronRight
            className={`text-sm transition-transform duration-200 ${advancedOpen ? "rotate-90" : ""}`}
          />
          <span>{t("dialog.advancedConfig")}</span>
          <span className="ml-auto truncate text-[0.625rem] text-muted-foreground/80">
            {advancedSummary}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3">
          <div className="grid gap-3 xl:grid-cols-3">
            <div className="rounded-lg border bg-accent/25 p-3">
              <div className="space-y-0.5">
                <div className="text-xs font-medium">{t("dialog.proxySelect")}</div>
                <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                  {proxyId
                    ? `${selectedProxyName ?? t("dialog.proxySelect")}`
                    : t("dialog.noProxy")}
                </p>
              </div>
              <div className="mt-3">
                <Label className="text-[0.6875rem] text-muted-foreground">
                  {t("dialog.proxySelect")}
                </Label>
                <Select
                  value={proxyId || "__none__"}
                  onValueChange={(value) => setProxyId(value === "__none__" ? "" : value)}
                >
                  <SelectTrigger className="mt-1 h-8 bg-background/85 text-xs">
                    <SelectValue placeholder={t("dialog.noProxy")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t("dialog.noProxy")}</SelectItem>
                    {proxies.map((proxy) => (
                      <SelectItem key={proxy.id} value={proxy.id}>
                        {proxy.name} ({proxy.protocol.toUpperCase()} {proxy.host}:{proxy.port})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="rounded-lg border bg-accent/25 p-3">
              <div className="space-y-0.5">
                <div className="text-xs font-medium">{t("dialog.proxyJump")}</div>
                <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                  {jumpHostId
                    ? (selectedJumpHost?.subtitle ??
                      selectedJumpHost?.connection.name ??
                      t("dialog.selectProxyJump"))
                    : t("dialog.noProxyJump")}
                </p>
              </div>
              <div className="mt-3">
                <Label className="text-[0.6875rem] text-muted-foreground">
                  {t("dialog.selectProxyJump")}
                </Label>
                <div className="mt-1">
                  <ConnectionCombobox
                    value={jumpHostId}
                    options={jumpHostOptions}
                    placeholder={t("dialog.noProxyJump")}
                    searchPlaceholder={t("network.searchConnections")}
                    emptyText={t("dialog.proxyJumpSshOnly")}
                    missingSelectionLabel={t("network.connectionMissing")}
                    clearLabel={t("dialog.noProxyJump")}
                    onChange={setJumpHostId}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-lg border bg-accent/25 p-3">
              <div className="space-y-0.5">
                <div className="text-xs font-medium">{t("dialog.twoFactorAuth")}</div>
                <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                  {otpId && selectedOtpLabel
                    ? `${selectedOtpLabel.issuer} (${selectedOtpLabel.username})`
                    : t("dialog.noOtp")}
                </p>
              </div>
              <div className="mt-3 space-y-3">
                <div>
                  <Label className="text-[0.6875rem] text-muted-foreground">
                    {t("dialog.selectOtp")}
                  </Label>
                  <Select
                    value={otpId || "__none__"}
                    onValueChange={(value) => {
                      const id = value === "__none__" ? "" : value;
                      setOtpId(id);
                      if (!id) setAutoFillOtp(false);
                    }}
                  >
                    <SelectTrigger className="mt-1 h-8 bg-background/85 text-xs">
                      <SelectValue placeholder={t("dialog.noOtp")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t("dialog.noOtp")}</SelectItem>
                      {otpEntries.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.issuer} ({entry.username})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="rounded-md border border-dashed bg-background/70 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[0.6875rem] font-medium">{t("dialog.autoFillOtp")}</div>
                      <div className="text-[0.625rem] text-muted-foreground">
                        {otpId ? t("dialog.twoFactorAuth") : t("dialog.noOtp")}
                      </div>
                    </div>
                    <Switch
                      checked={otpId ? autoFillOtp : false}
                      onCheckedChange={setAutoFillOtp}
                      disabled={!otpId}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Dialog
        open={showKeyManagement}
        onOpenChange={(open) => {
          setShowKeyManagement(open);
          if (!open) {
            void loadSshKeys();
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t("settings.keyManagement")}</DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto pr-1">
            <KeyManagementTab />
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showPasswordManagement}
        onOpenChange={(open) => {
          setShowPasswordManagement(open);
          if (!open) {
            void loadPasswords();
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t("passwordManager.title")}</DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto pr-1">
            <PasswordManagementTab />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

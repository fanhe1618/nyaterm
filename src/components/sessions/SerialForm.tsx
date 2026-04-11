import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SerialPortOption {
  unavailable?: boolean;
  value: string;
}

interface SerialFormProps {
  serialPortName: string;
  setSerialPortName: (v: string) => void;
  serialPortOptions: SerialPortOption[];
  serialPortsLoading: boolean;
  serialPortsError: string;
  onSerialPortDropdownOpen: () => void;
  baudRate: string;
  setBaudRate: (v: string) => void;
  dataBits: string;
  setDataBits: (v: string) => void;
  parity: string;
  setParity: (v: string) => void;
  stopBits: string;
  setStopBits: (v: string) => void;
}

export function SerialForm({
  serialPortName,
  setSerialPortName,
  serialPortOptions,
  serialPortsLoading,
  serialPortsError,
  onSerialPortDropdownOpen,
  baudRate,
  setBaudRate,
  dataBits,
  setDataBits,
  parity,
  setParity,
  stopBits,
  setStopBits,
}: SerialFormProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4 w-full">
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[14rem] flex-[2_1_15rem]">
          <Label className="text-[0.6875rem] text-muted-foreground">
            {t("dialog.serialPort", "Serial Port")}
          </Label>
          <Select
            value={serialPortName || undefined}
            onValueChange={setSerialPortName}
            onOpenChange={(open) => {
              if (open) {
                onSerialPortDropdownOpen();
              }
            }}
          >
            <SelectTrigger className="mt-1 h-8 text-xs font-normal">
              <SelectValue
                placeholder={t("dialog.selectSerialPort", "Select Serial Port")}
              />
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="start"
              side="bottom"
              sideOffset={4}
              className="w-[var(--radix-select-trigger-width)]"
            >
              {serialPortsLoading ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t("dialog.loadingSerialPorts", "Loading serial ports...")}
                </div>
              ) : serialPortOptions.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t("dialog.noSerialPortsFound", "No serial ports found")}
                </div>
              ) : (
                serialPortOptions.map((port) => (
                  <SelectItem key={port.value} value={port.value}>
                    {port.unavailable
                      ? t("dialog.serialPortUnavailable", {
                          port: port.value,
                          defaultValue: "{{port}} (Unavailable)",
                        })
                      : port.value}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {serialPortsError && (
            <p className="mt-1 text-[0.6875rem] text-destructive">{serialPortsError}</p>
          )}
        </div>
        <div className="min-w-[9rem] flex-[1_1_9rem]">
          <Label className="text-[0.6875rem] text-muted-foreground">
            {t("dialog.baudRate", "Baud Rate")}
          </Label>
          <Select value={baudRate} onValueChange={setBaudRate}>
            <SelectTrigger className="mt-1 h-8 text-xs font-normal">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="9600">9600</SelectItem>
              <SelectItem value="19200">19200</SelectItem>
              <SelectItem value="38400">38400</SelectItem>
              <SelectItem value="57600">57600</SelectItem>
              <SelectItem value="115200">115200</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[7rem] flex-[0.9_1_7rem]">
          <Label className="text-[0.6875rem] text-muted-foreground">
            {t("dialog.dataBits", "Data Bits")}
          </Label>
          <Select value={dataBits} onValueChange={setDataBits}>
            <SelectTrigger className="mt-1 h-8 text-xs font-normal">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">5</SelectItem>
              <SelectItem value="6">6</SelectItem>
              <SelectItem value="7">7</SelectItem>
              <SelectItem value="8">8</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[10rem] flex-[1.4_1_10rem]">
          <Label className="text-[0.6875rem] text-muted-foreground">
            {t("dialog.parity", "Parity")}
          </Label>
          <Select value={parity} onValueChange={setParity}>
            <SelectTrigger className="mt-1 h-8 text-xs font-normal">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("dialog.parityNone", "None")}</SelectItem>
              <SelectItem value="odd">{t("dialog.parityOdd", "Odd")}</SelectItem>
              <SelectItem value="even">{t("dialog.parityEven", "Even")}</SelectItem>
              <SelectItem value="mark">{t("dialog.parityMark", "Mark")}</SelectItem>
              <SelectItem value="space">{t("dialog.paritySpace", "Space")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[7rem] flex-[0.9_1_7rem]">
          <Label className="text-[0.6875rem] text-muted-foreground">
            {t("dialog.stopBits", "Stop Bits")}
          </Label>
          <Select value={stopBits} onValueChange={setStopBits}>
            <SelectTrigger className="mt-1 h-8 text-xs font-normal">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1</SelectItem>
              <SelectItem value="1.5">1.5</SelectItem>
              <SelectItem value="2">2</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

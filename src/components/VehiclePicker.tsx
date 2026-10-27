/** Searchable single-vehicle picker on Zenith's Dropdown. */

import { useMemo } from "react";
import { Dropdown, type ISelectionItem } from "@geotab/zenith";
import type { GeotabDevice } from "../types";
import { Field } from "./fields";

interface Props {
  label?: string;
  devices: GeotabDevice[];
  value: string | null;
  onChange: (deviceId: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function VehiclePicker({ label = "Vehicle", devices, value, onChange, disabled, placeholder = "Select a vehicle" }: Props) {
  const items = useMemo(
    () =>
      devices
        .map((d) => ({ id: d.id, name: d.name ?? d.id }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    [devices]
  );
  return (
    <Field label={label}>
      <Dropdown
        value={value ? [value] : []}
        dataItems={items}
        onChange={(sel: ISelectionItem[]) => onChange(sel[0]?.id ? String(sel[0].id) : null)}
        errorHandler={(e) => console.error("[MWO] vehicle picker:", e)}
        multiselect={false}
        searchField
        showSelection
        showCounterPill={false}
        fullWidthTriggerButton
        disabled={disabled}
        placeholder={placeholder}
        listLimit={400}
      />
    </Field>
  );
}

/**
 * Native-style group picker built on Zenith's GroupsFilter.
 *
 * Ported from vehicle-replacement-planner-addin so the group selector behaves
 * identically across GPSFMS add-ins: multi-select, hierarchical, surfaces
 * flat IDs to the parent.
 */

import { useCallback, useMemo, useState } from "react";
import {
  GroupsFilter,
  RelationOperator,
  type IGroupItem,
  type IGroupsFilterTotalState,
  type IFilterState,
} from "@geotab/zenith";
import type { GeotabGroup } from "../types";

export interface GroupFilterPickerProps {
  groupsById: Map<string, GeotabGroup>;
  initialGroupIds?: string[];
  onChange: (groupIds: string[]) => void;
  onError?: (e: Error) => void;
}

function buildGroupItemArr(byId: Map<string, GeotabGroup>): IGroupItem[] {
  const items: IGroupItem[] = [];
  byId.forEach((g) => {
    items.push({
      id: g.id,
      name: g.name && g.name.length > 0 ? g.name : g.id,
      children: Array.isArray(g.children) && g.children.length > 0 ? g.children.map((c) => ({ id: c.id })) : undefined,
    });
  });
  items.sort((a, b) => {
    if (a.id === "GroupCompanyId") return -1;
    if (b.id === "GroupCompanyId") return 1;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
  return items;
}

function flattenIds(state: IFilterState | undefined): string[] {
  if (!state || !Array.isArray(state.items)) return [];
  const out: string[] = [];
  for (const item of state.items) {
    if (item && typeof item === "object" && "items" in item && Array.isArray((item as IFilterState).items)) {
      out.push(...flattenIds(item as IFilterState));
    } else if (item && typeof item === "object" && "id" in item && typeof (item as { id: string }).id === "string") {
      out.push((item as { id: string }).id);
    }
  }
  return out;
}

export function GroupFilterPicker({ groupsById, initialGroupIds, onChange, onError }: GroupFilterPickerProps) {
  const [state, setState] = useState<IGroupsFilterTotalState>(() => {
    const ids = initialGroupIds && initialGroupIds.length > 0 ? initialGroupIds : ["GroupCompanyId"];
    return {
      groups: { relation: RelationOperator.OR, items: ids.map((id) => ({ id })) },
      sideWide: false,
    };
  });

  const dataLoader = useCallback(async (): Promise<IGroupItem[]> => buildGroupItemArr(groupsById), [groupsById]);

  const handleChange = useCallback(
    (next: IGroupsFilterTotalState) => {
      setState(next);
      onChange(flattenIds(next.groups));
    },
    [onChange]
  );

  const errorHandler = useCallback(
    (e: Error) => {
      console.error("[MWO] GroupsFilter error:", e);
      onError?.(e);
    },
    [onError]
  );

  const initialFilterState = useMemo(() => state, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <GroupsFilter dataLoader={dataLoader} onChange={handleChange} errorHandler={errorHandler} initialFilterState={initialFilterState} />;
}

/**
 * EntityPanel<T> — Config-driven entity list with built-in keyboard nav + multi-select.
 *
 * Wraps EntityList + EntityRow + useEntityListInteractions so consumers
 * only provide a data mapping via `mapItem`.
 */

import * as React from 'react'
import { useAction } from '@/actions'
import { EntityList, type EntityListGroup } from './entity-list'
import { EntityRow } from './entity-row'
import { useEntityListInteractions } from '@/hooks/useEntityListInteractions'
import type { createEntitySelection } from '@/hooks/useEntitySelection'

export interface EntityPanelItem {
  icon?: React.ReactNode
  title: React.ReactNode
  badges?: React.ReactNode
  trailing?: React.ReactNode
  menu?: React.ReactNode
  dataAttributes?: Record<string, string | undefined>
}

export interface EntityPanelProps<T> {
  /**
   * Every item, in navigation order. Keyboard nav and range selection run over
   * this list, so it stays flat even when `groups` renders it in sections.
   */
  items: T[]
  /** Optional section rendering. Must partition `items`, not replace them. */
  groups?: EntityListGroup<T>[]
  getId: (item: T) => string
  mapItem: (item: T) => EntityPanelItem
  selection: ReturnType<typeof createEntitySelection>
  onItemClick: (item: T) => void
  selectedId?: string | null
  emptyState?: React.ReactNode
  className?: string
  /** Extra data/aria attributes merged onto the inner list container.
   *  Use to set `data-list-role` so compact-mode CSS can target the right list. */
  containerProps?: Record<string, string>
}

export function EntityPanel<T>({
  items,
  groups,
  getId,
  mapItem,
  selection,
  onItemClick,
  selectedId,
  emptyState,
  className,
  containerProps,
}: EntityPanelProps<T>) {
  const selectionStore = selection.useSelectionStore()
  const interactions = useEntityListInteractions<T>({
    items,
    getId,
    keyboard: {
      onNavigate: (item) => onItemClick(item),
      onActivate: (item) => onItemClick(item),
    },
    multiSelect: true,
    selectionStore,
  })

  useAction('navigator.clearSelection', () => {
    interactions.selection.clear()
  }, {
    enabled: () => interactions.selection.isMultiSelectActive,
  }, [interactions.selection])

  // Grouped rendering hands renderItem an index within its section, but row
  // props are keyed on the position in the flat list.
  const flatIndexById = React.useMemo(() => {
    const map = new Map<string, number>()
    items.forEach((item, index) => map.set(getId(item), index))
    return map
  }, [items, getId])

  const mergedContainerProps = containerProps
    ? { ...interactions.listProps.containerProps, ...containerProps }
    : interactions.listProps.containerProps

  return (
    <EntityList
      items={items}
      groups={groups}
      getKey={getId}
      containerRef={interactions.listProps.containerRef}
      containerProps={mergedContainerProps}
      className={className}
      emptyState={emptyState}
      renderItem={(item, index, isFirst) => {
        const mapped = mapItem(item)
        const rowProps = interactions.getRowProps(item, flatIndexById.get(getId(item)) ?? index)
        return (
          <EntityRow
            icon={mapped.icon}
            title={mapped.title}
            badges={mapped.badges}
            trailing={mapped.trailing}
            isSelected={selectedId === getId(item)}
            isInMultiSelect={rowProps.isInMultiSelect}
            showSeparator={!isFirst}
            onMouseDown={(e) => {
              rowProps.onMouseDown(e)
              if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button !== 2) {
                onItemClick(item)
              }
            }}
            buttonProps={rowProps.buttonProps}
            menuContent={mapped.menu}
            dataAttributes={mapped.dataAttributes}
          />
        )
      }}
    />
  )
}

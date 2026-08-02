import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete"

import { cn } from "@/lib/utils"

function Autocomplete<ItemValue = string>({
  items,
  ...props
}: Omit<AutocompletePrimitive.Root.Props<ItemValue>, "items"> & {
  items?: readonly ItemValue[]
}) {
  return (
    <AutocompletePrimitive.Root<ItemValue> data-slot="autocomplete" items={items} {...props} />
  )
}

function AutocompleteInput({ className, ...props }: AutocompletePrimitive.Input.Props) {
  return (
    <AutocompletePrimitive.Input
      data-slot="autocomplete-input"
      className={cn(
        "flex h-6 w-24 rounded-md border border-dashed border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function AutocompletePopup({
  className,
  children,
  sideOffset = 4,
  ...props
}: AutocompletePrimitive.Popup.Props & Pick<AutocompletePrimitive.Positioner.Props, "sideOffset">) {
  return (
    <AutocompletePrimitive.Portal>
      <AutocompletePrimitive.Positioner sideOffset={sideOffset} className="z-50 outline-none">
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-popup"
          className={cn(
            "max-h-64 w-(--anchor-width) min-w-40 overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
        </AutocompletePrimitive.Popup>
      </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
  )
}

function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
  return (
    <AutocompletePrimitive.List
      data-slot="autocomplete-list"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  )
}

function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        "flex cursor-default items-center gap-1.5 rounded-sm px-2 py-1 text-xs outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

function AutocompleteEmpty({ className, ...props }: AutocompletePrimitive.Empty.Props) {
  return (
    <AutocompletePrimitive.Empty
      data-slot="autocomplete-empty"
      className={cn("px-2 py-1.5 text-xs text-muted-foreground empty:hidden", className)}
      {...props}
    />
  )
}

export {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
}

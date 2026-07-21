import { Button, type ButtonProps } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { Input, type InputProps } from '@base-ui/react/input';
import { Select } from '@base-ui/react/select';
import { Switch } from '@base-ui/react/switch';
import { Tooltip } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

export function GameButton({ className, ...props }: ButtonProps): ReactElement {
  return <Button className={className} {...props} />;
}

export function GameInput({ className, ...props }: InputProps): ReactElement {
  return <Input className={`base-input ${className ?? ''}`.trim()} {...props} />;
}

export interface GameSelectOption<Value extends string> {
  readonly value: Value;
  readonly label: ReactNode;
}

interface GameSelectProps<Value extends string> {
  readonly value: Value;
  readonly options: readonly GameSelectOption<Value>[];
  readonly onValueChange: (value: Value) => void;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly ariaLabel: string;
}

export function GameSelect<Value extends string>({
  value,
  options,
  onValueChange,
  className,
  disabled = false,
  ariaLabel,
}: GameSelectProps<Value>): ReactElement {
  return (
    <Select.Root<Value>
      value={value}
      disabled={disabled}
      onValueChange={(nextValue) => {
        if (nextValue !== null) onValueChange(nextValue);
      }}
    >
      <Select.Trigger className={`base-select ${className ?? ''}`.trim()} aria-label={ariaLabel}>
        <Select.Value>
          {(selectedValue) => options.find((option) => option.value === selectedValue)?.label ?? ''}
        </Select.Value>
        <Select.Icon className="base-select-icon" aria-hidden="true">
          ▾
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} align="start">
          <Select.Popup className="base-select-popup">
            <Select.List>
              {options.map((option) => (
                <Select.Item className="base-select-item" key={option.value} value={option.value}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator className="base-select-indicator">✓</Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

interface GameSwitchProps {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly ariaLabel: string;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly children: ReactNode;
}

export function GameSwitch({
  checked,
  disabled = false,
  className,
  ariaLabel,
  onCheckedChange,
  children,
}: GameSwitchProps): ReactElement {
  return (
    <div className={`base-switch-field ${className ?? ''}`.trim()}>
      <Switch.Root
        className="base-switch"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onCheckedChange={(nextChecked) => {
          onCheckedChange(nextChecked);
        }}
      >
        <Switch.Thumb className="base-switch-thumb" />
      </Switch.Root>
      <span className="base-switch-label">{children}</span>
    </div>
  );
}

interface HoverTipProps {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  readonly block?: boolean;
}

export function HoverTip({
  label,
  children,
  side = 'top',
  block = false,
}: HoverTipProps): ReactElement {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          block ? (
            <div className="base-tooltip-trigger" />
          ) : (
            <span className="base-tooltip-trigger" />
          )
        }
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={8}>
          <Tooltip.Popup className="base-tooltip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

interface ModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Modal({
  open,
  onOpenChange,
  label,
  children,
  className = '',
}: ModalProps): ReactElement {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="base-dialog-backdrop" />
        <Dialog.Viewport className="base-dialog-viewport">
          <Dialog.Popup aria-label={label} className={`modal-box ${className}`.trim()}>
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

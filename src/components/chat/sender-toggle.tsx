
"use client";

import type { SenderType } from '@/types/chat';
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

interface SenderToggleProps {
  currentSender: SenderType;
  onSenderChange: (sender: SenderType) => void;
}

export function SenderToggle({ currentSender, onSenderChange }: SenderToggleProps) {
  return (
    <div className="mb-4">
      <RadioGroup
        defaultValue={currentSender}
        onValueChange={(value) => onSenderChange(value as SenderType)}
        className="flex items-center space-x-4"
      >
        <Label htmlFor="sender-type" className="text-sm font-medium text-foreground">Interacting as:</Label>
        <div className="flex items-center space-x-2">
          <RadioGroupItem value="patient" id="patient" />
          <Label htmlFor="patient" className="font-normal">Patient</Label>
        </div>
        <div className="flex items-center space-x-2">
          <RadioGroupItem value="doctor" id="doctor" />
          <Label htmlFor="doctor" className="font-normal">Doctor</Label>
        </div>
      </RadioGroup>
    </div>
  );
}

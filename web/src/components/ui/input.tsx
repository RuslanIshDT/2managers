import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-md border border-[#dde1e7] bg-white px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1f5fbf]',
        className,
      )}
      {...props}
    />
  );
}

import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.ts';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-[#dde1e7] bg-white p-5 shadow-sm', className)} {...props} />;
}

// Class composition: clsx concatenation + tailwind-merge conflict dedupe (the
// standard combo for Radix base components overriding className).
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

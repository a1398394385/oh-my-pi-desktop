import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  width?: number;
}

export function SearchInput({ value, onChange, placeholder, width }: SearchInputProps) {
  const { t } = useTranslation();
  return (
    <label className="search">
      <Search size={14} />
      <input
        className="input inp"
        type="search"
        value={value}
        placeholder={placeholder ?? t("settingsPage.stats.ui.filterPlaceholder")}
        onChange={(e) => onChange(e.target.value)}
        style={width !== undefined ? { width } : undefined}
      />
    </label>
  );
}

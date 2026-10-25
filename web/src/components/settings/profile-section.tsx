import { useEffect, useState } from "react";
import { Save } from "lucide-react";

import { settingsApi } from "@/api/client";
import type { MeProfile } from "@/api/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getTimezones } from "@/lib/datetime";

const LANGUAGES = [
  { value: "zh", label: "中文（简体）" },
  { value: "en", label: "English" },
];

const selectClass =
  "flex h-9 w-full min-w-0 rounded-md border border-paper-300 bg-paper-50 px-3 py-1 text-sm text-ink-900 outline-none transition-colors focus-visible:border-seal-500 focus-visible:ring-2 focus-visible:ring-seal-500/30";

export function ProfileSection({
  user,
  onSaved,
}: {
  user: MeProfile;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(user.display_name);
  const [timezone, setTimezone] = useState(user.timezone);
  const [language, setLanguage] = useState(user.language);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(user.display_name);
    setTimezone(user.timezone);
    setLanguage(user.language);
  }, [user]);

  const timezones = getTimezones();

  const save = async () => {
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      await settingsApi.updateMe({
        display_name: displayName,
        timezone,
        language,
      });
      await onSaved();
      setNotice("已保存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>个人资料</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label htmlFor="display-name" className="mb-1.5 block text-sm font-medium text-ink-700">
            昵称（公开信墙显示用）
          </label>
          <Input
            id="display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="留空则显示「一位朋友」"
            maxLength={50}
          />
        </div>
        <div>
          <label htmlFor="timezone" className="mb-1.5 block text-sm font-medium text-ink-700">
            时区
          </label>
          <select
            id="timezone"
            className={selectClass}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {!timezones.includes(timezone) && <option value={timezone}>{timezone}</option>}
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="language" className="mb-1.5 block text-sm font-medium text-ink-700">
            语言
          </label>
          <select
            id="language"
            className={selectClass}
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p role="alert" className="rounded-md border border-seal-500/30 bg-seal-500/10 px-3 py-2 text-sm text-seal-600">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-md border border-paper-300 bg-paper-100 px-3 py-2 text-sm text-ink-700">
            {notice}
          </p>
        )}

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            <Save className="size-4" />
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

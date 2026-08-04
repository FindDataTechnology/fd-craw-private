// SkillForm.tsx
// Modal form for adding/editing custom skills.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { CustomSkill } from "@/lib/extensions-api";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface SkillFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill?: CustomSkill | null;
  initialSkill?: { name: string; description: string; content: string } | null;
}

export function SkillForm({ open, onOpenChange, skill, initialSkill }: SkillFormProps) {
  const { t } = useTranslation();
  const { addCustomSkill, updateCustomSkill } = useExtensionsStore();

  const isEdit = !!skill;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (skill) {
      setName(skill.name);
      setDescription(skill.description || "");
      setContent(skill.content);
      setEnabled(skill.enabled);
    } else if (initialSkill) {
      setName(initialSkill.name || "");
      setDescription(initialSkill.description || "");
      setContent(initialSkill.content || "");
      setEnabled(true);
    } else {
      setName("");
      setDescription("");
      setContent("");
      setEnabled(true);
    }
    setError("");
  }, [skill, initialSkill, open]);

  const handleSubmit = async () => {
    setError("");
    if (!name.trim()) {
      setError(t("extensions.skills.errors.nameRequired"));
      return;
    }
    if (!content.trim()) {
      setError(t("extensions.skills.errors.contentRequired"));
      return;
    }

    setLoading(true);
    try {
      if (isEdit) {
        await updateCustomSkill(skill!.name, description, content, enabled);
      } else {
        await addCustomSkill(name.trim(), description, content, enabled);
      }
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("extensions.skills.editTitle") : t("extensions.skills.addTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <div className="bg-destructive/10 text-destructive px-3 py-2 rounded-md text-sm">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="name">{t("extensions.skills.fields.name")}</Label>
            <Input
              id="name"
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              disabled={isEdit}
              placeholder="my-custom-skill"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">{t("extensions.skills.fields.description")}</Label>
            <Input
              id="description"
              value={description}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
              placeholder="A brief description of what this skill does"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="content">{t("extensions.skills.fields.content")}</Label>
            <Textarea
              id="content"
              value={content}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
              rows={12}
              className="font-mono text-xs"
              placeholder="You are a helpful assistant that..."
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch id="enabled" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="enabled">{t("extensions.fields.enabled")}</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? t("common.saving") : isEdit ? t("common.save") : t("common.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use server';

import type { RunId, WorkspaceId } from '@aoc/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cancelRunFor, commandErrorMessage, createAndStartRun, decide, startDraftRun } from '@/lib/run-commands';
import { parseDecisionForm, parseNewRunForm, type FormState } from '@/lib/run-forms';
import { commandDb } from '@/lib/server/db';
import { requireUser } from '@/lib/server/session';

// Every action resolves the user from the verified session, finds the workspace through a read under row-level
// security (a non-member sees nothing), and leaves authorisation and the transition to packages/core.

export async function createRunAction(_previous: FormState, form: FormData): Promise<FormState> {
  const { supabase, userId } = await requireUser();
  const parsed = parseNewRunForm(form);
  if (!parsed.ok) return { error: parsed.error };
  const { data: project } = await supabase
    .from('projects')
    .select('workspace_id')
    .eq('id', parsed.value.projectId)
    .maybeSingle();
  if (!project) return { error: 'That project is not in your workspace.' };
  let runId: RunId;
  try {
    runId = await createAndStartRun(commandDb(), userId, project.workspace_id as WorkspaceId, parsed.value);
  } catch (error) {
    return { error: commandErrorMessage(error) };
  }
  redirect(`/runs/${runId}`);
}

export async function decideApprovalAction(_previous: FormState, form: FormData): Promise<FormState> {
  const { supabase, userId } = await requireUser();
  const parsed = parseDecisionForm(form);
  if (!parsed.ok) return { error: parsed.error };
  const { data: approval } = await supabase
    .from('approvals')
    .select('workspace_id, run_id')
    .eq('id', parsed.value.approvalId)
    .maybeSingle();
  if (!approval) return { error: 'That approval is not in your workspace.' };
  try {
    await decide(commandDb(), userId, approval.workspace_id as WorkspaceId, parsed.value);
  } catch (error) {
    return { error: commandErrorMessage(error) };
  }
  revalidatePath(`/runs/${approval.run_id}`);
  return { error: null };
}

export async function runControlAction(_previous: FormState, form: FormData): Promise<FormState> {
  const { supabase, userId } = await requireUser();
  const runId = form.get('runId');
  const intent = form.get('intent');
  if (typeof runId !== 'string' || (intent !== 'start' && intent !== 'cancel'))
    return { error: 'The request could not be read. Reload the page and try again.' };
  const { data: run } = await supabase.from('runs').select('id, workspace_id').eq('id', runId).maybeSingle();
  if (!run) return { error: 'That run is not in your workspace.' };
  try {
    const command = intent === 'start' ? startDraftRun : cancelRunFor;
    await command(commandDb(), userId, run.workspace_id as WorkspaceId, run.id as RunId);
  } catch (error) {
    return { error: commandErrorMessage(error) };
  }
  revalidatePath(`/runs/${run.id}`);
  return { error: null };
}

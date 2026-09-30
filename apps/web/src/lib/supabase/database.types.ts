export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      approvals: {
        Row: {
          decided_at: string | null
          decided_by: string | null
          decision: string | null
          decision_reason: string | null
          id: string
          invalidated_at: string | null
          invalidation_detail: string | null
          invalidation_reason: string | null
          replaced_by: string | null
          requested_at: string
          run_id: string
          snapshot: Json
          snapshot_hash: string
          snapshot_hash_seen: string | null
          snapshot_schema_version: number
          status: string
          target: Json
          target_key: string
          task_id: string | null
          type: string
          workspace_id: string
        }
        Insert: {
          decided_at?: string | null
          decided_by?: string | null
          decision?: string | null
          decision_reason?: string | null
          id?: string
          invalidated_at?: string | null
          invalidation_detail?: string | null
          invalidation_reason?: string | null
          replaced_by?: string | null
          requested_at?: string
          run_id: string
          snapshot: Json
          snapshot_hash: string
          snapshot_hash_seen?: string | null
          snapshot_schema_version: number
          status?: string
          target: Json
          target_key: string
          task_id?: string | null
          type: string
          workspace_id: string
        }
        Update: {
          decided_at?: string | null
          decided_by?: string | null
          decision?: string | null
          decision_reason?: string | null
          id?: string
          invalidated_at?: string | null
          invalidation_detail?: string | null
          invalidation_reason?: string | null
          replaced_by?: string | null
          requested_at?: string
          run_id?: string
          snapshot?: Json
          snapshot_hash?: string
          snapshot_hash_seen?: string | null
          snapshot_schema_version?: number
          status?: string
          target?: Json
          target_key?: string
          task_id?: string | null
          type?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "approvals_replaced_by_fkey"
            columns: ["replaced_by"]
            isOneToOne: false
            referencedRelation: "approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_run_id_workspace_id_fkey"
            columns: ["run_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "approvals_task_id_workspace_id_fkey"
            columns: ["task_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor: Json
          created_at: string
          id: number
          metadata: Json
          target_id: string | null
          target_type: string | null
          workspace_id: string
        }
        Insert: {
          action: string
          actor: Json
          created_at?: string
          id?: never
          metadata?: Json
          target_id?: string | null
          target_type?: string | null
          workspace_id: string
        }
        Update: {
          action?: string
          actor?: Json
          created_at?: string
          id?: never
          metadata?: Json
          target_id?: string | null
          target_type?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      run_events: {
        Row: {
          actor: Json
          data: Json
          occurred_at: string
          refs: Json
          run_id: string
          seq: number
          type: string
          workspace_id: string
        }
        Insert: {
          actor: Json
          data?: Json
          occurred_at?: string
          refs?: Json
          run_id: string
          seq: number
          type: string
          workspace_id: string
        }
        Update: {
          actor?: Json
          data?: Json
          occurred_at?: string
          refs?: Json
          run_id?: string
          seq?: number
          type?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_events_run_id_workspace_id_fkey"
            columns: ["run_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      runs: {
        Row: {
          brief: Json | null
          budget: Json
          budget_blocked: boolean
          cancel_requested: boolean
          created_at: string
          created_by: string
          failure: Json | null
          finished_at: string | null
          id: string
          last_event_seq: number
          objective: string
          pause_reason: string | null
          pause_requested: boolean
          project_id: string
          spend_cost_usd_micros: number
          spend_llm_input_tokens: number
          spend_llm_output_tokens: number
          spend_tool_calls: number
          started_at: string | null
          status: string
          updated_at: string
          workflow: string
          workflow_version: number
          workspace_id: string
        }
        Insert: {
          brief?: Json | null
          budget: Json
          budget_blocked?: boolean
          cancel_requested?: boolean
          created_at?: string
          created_by: string
          failure?: Json | null
          finished_at?: string | null
          id?: string
          last_event_seq?: number
          objective: string
          pause_reason?: string | null
          pause_requested?: boolean
          project_id: string
          spend_cost_usd_micros?: number
          spend_llm_input_tokens?: number
          spend_llm_output_tokens?: number
          spend_tool_calls?: number
          started_at?: string | null
          status?: string
          updated_at?: string
          workflow: string
          workflow_version: number
          workspace_id: string
        }
        Update: {
          brief?: Json | null
          budget?: Json
          budget_blocked?: boolean
          cancel_requested?: boolean
          created_at?: string
          created_by?: string
          failure?: Json | null
          finished_at?: string | null
          id?: string
          last_event_seq?: number
          objective?: string
          pause_reason?: string | null
          pause_requested?: boolean
          project_id?: string
          spend_cost_usd_micros?: number
          spend_llm_input_tokens?: number
          spend_llm_output_tokens?: number
          spend_tool_calls?: number
          started_at?: string | null
          status?: string
          updated_at?: string
          workflow?: string
          workflow_version?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "runs_project_id_workspace_id_fkey"
            columns: ["project_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      task_dependencies: {
        Row: {
          created_at: string
          depends_on_task_id: string
          mode: string
          run_id: string
          task_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          depends_on_task_id: string
          mode: string
          run_id: string
          task_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          depends_on_task_id?: string
          mode?: string
          run_id?: string
          task_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_dependencies_depends_on_task_id_run_id_fkey"
            columns: ["depends_on_task_id", "run_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "run_id"]
          },
          {
            foreignKeyName: "task_dependencies_run_id_workspace_id_fkey"
            columns: ["run_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "task_dependencies_task_id_run_id_fkey"
            columns: ["task_id", "run_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "run_id"]
          },
        ]
      }
      tasks: {
        Row: {
          attempt: number
          created_at: string
          finished_at: string | null
          heartbeat_at: string | null
          id: string
          idempotency_key: string
          input: Json
          kind: string
          last_failure: Json | null
          lease_expires_at: string | null
          lease_owner: string | null
          lease_token: string | null
          max_attempts: number
          output: Json | null
          parent_task_id: string | null
          priority: number
          run_after: string
          run_id: string
          started_at: string | null
          status: string
          subject_company_id: string | null
          type: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempt?: number
          created_at?: string
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          idempotency_key: string
          input: Json
          kind: string
          last_failure?: Json | null
          lease_expires_at?: string | null
          lease_owner?: string | null
          lease_token?: string | null
          max_attempts: number
          output?: Json | null
          parent_task_id?: string | null
          priority?: number
          run_after?: string
          run_id: string
          started_at?: string | null
          status?: string
          subject_company_id?: string | null
          type: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempt?: number
          created_at?: string
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          idempotency_key?: string
          input?: Json
          kind?: string
          last_failure?: Json | null
          lease_expires_at?: string | null
          lease_owner?: string | null
          lease_token?: string | null
          max_attempts?: number
          output?: Json | null
          parent_task_id?: string | null
          priority?: number
          run_after?: string
          run_id?: string
          started_at?: string | null
          status?: string
          subject_company_id?: string | null
          type?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_run_id_workspace_id_fkey"
            columns: ["run_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string
          role: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          role: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          role?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          id: string
          name: string
          slug: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          slug: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          slug?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const


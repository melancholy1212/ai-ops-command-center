export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      agent_executions: {
        Row: {
          agent: string;
          agent_version: string;
          attempt: number;
          cost_usd_micros: number;
          ended_at: string | null;
          failure: Json | null;
          id: string;
          input: Json;
          input_tokens: number;
          lease_token: string;
          limits: Json;
          llm_calls: number;
          output: Json | null;
          output_tokens: number;
          prompt_hash: string;
          run_id: string;
          started_at: string;
          status: string;
          task_id: string;
          tool_calls: number;
          turns: number;
          workspace_id: string;
        };
        Insert: {
          agent: string;
          agent_version: string;
          attempt: number;
          cost_usd_micros?: number;
          ended_at?: string | null;
          failure?: Json | null;
          id?: string;
          input: Json;
          input_tokens?: number;
          lease_token: string;
          limits: Json;
          llm_calls?: number;
          output?: Json | null;
          output_tokens?: number;
          prompt_hash: string;
          run_id: string;
          started_at?: string;
          status?: string;
          task_id: string;
          tool_calls?: number;
          turns?: number;
          workspace_id: string;
        };
        Update: {
          agent?: string;
          agent_version?: string;
          attempt?: number;
          cost_usd_micros?: number;
          ended_at?: string | null;
          failure?: Json | null;
          id?: string;
          input?: Json;
          input_tokens?: number;
          lease_token?: string;
          limits?: Json;
          llm_calls?: number;
          output?: Json | null;
          output_tokens?: number;
          prompt_hash?: string;
          run_id?: string;
          started_at?: string;
          status?: string;
          task_id?: string;
          tool_calls?: number;
          turns?: number;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'agent_executions_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'agent_executions_task_id_run_id_fkey';
            columns: ['task_id', 'run_id'];
            isOneToOne: false;
            referencedRelation: 'tasks';
            referencedColumns: ['id', 'run_id'];
          },
        ];
      };
      agent_messages: {
        Row: {
          content: Json;
          created_at: string;
          execution_id: string;
          role: string;
          seq: number;
          workspace_id: string;
        };
        Insert: {
          content: Json;
          created_at?: string;
          execution_id: string;
          role: string;
          seq: number;
          workspace_id: string;
        };
        Update: {
          content?: Json;
          created_at?: string;
          execution_id?: string;
          role?: string;
          seq?: number;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'agent_messages_execution_id_workspace_id_fkey';
            columns: ['execution_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'agent_executions';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      approvals: {
        Row: {
          decided_at: string | null;
          decided_by: string | null;
          decision: string | null;
          decision_reason: string | null;
          id: string;
          invalidated_at: string | null;
          invalidation_detail: string | null;
          invalidation_reason: string | null;
          replaced_by: string | null;
          requested_at: string;
          run_id: string;
          snapshot: Json;
          snapshot_hash: string;
          snapshot_hash_seen: string | null;
          snapshot_schema_version: number;
          status: string;
          target: Json;
          target_key: string;
          task_id: string | null;
          type: string;
          workspace_id: string;
        };
        Insert: {
          decided_at?: string | null;
          decided_by?: string | null;
          decision?: string | null;
          decision_reason?: string | null;
          id?: string;
          invalidated_at?: string | null;
          invalidation_detail?: string | null;
          invalidation_reason?: string | null;
          replaced_by?: string | null;
          requested_at?: string;
          run_id: string;
          snapshot: Json;
          snapshot_hash: string;
          snapshot_hash_seen?: string | null;
          snapshot_schema_version: number;
          status?: string;
          target: Json;
          target_key: string;
          task_id?: string | null;
          type: string;
          workspace_id: string;
        };
        Update: {
          decided_at?: string | null;
          decided_by?: string | null;
          decision?: string | null;
          decision_reason?: string | null;
          id?: string;
          invalidated_at?: string | null;
          invalidation_detail?: string | null;
          invalidation_reason?: string | null;
          replaced_by?: string | null;
          requested_at?: string;
          run_id?: string;
          snapshot?: Json;
          snapshot_hash?: string;
          snapshot_hash_seen?: string | null;
          snapshot_schema_version?: number;
          status?: string;
          target?: Json;
          target_key?: string;
          task_id?: string | null;
          type?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'approvals_replaced_by_fkey';
            columns: ['replaced_by'];
            isOneToOne: false;
            referencedRelation: 'approvals';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'approvals_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'approvals_task_id_workspace_id_fkey';
            columns: ['task_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'tasks';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      artifact_references: {
        Row: {
          artifact_id: string;
          claim_id: string | null;
          finding_id: string | null;
          workspace_id: string;
        };
        Insert: {
          artifact_id: string;
          claim_id?: string | null;
          finding_id?: string | null;
          workspace_id: string;
        };
        Update: {
          artifact_id?: string;
          claim_id?: string | null;
          finding_id?: string | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'artifact_references_artifact_id_workspace_id_fkey';
            columns: ['artifact_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'artifacts';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'artifact_references_claim_id_workspace_id_fkey';
            columns: ['claim_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'claims';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'artifact_references_finding_id_workspace_id_fkey';
            columns: ['finding_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'findings';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      artifacts: {
        Row: {
          author_execution_id: string | null;
          author_kind: string;
          author_module: string | null;
          author_version: string | null;
          content: Json;
          content_hash: string;
          created_at: string;
          id: string;
          kind: string;
          previous_version_id: string | null;
          run_id: string;
          status: string;
          version: number;
          workspace_id: string;
        };
        Insert: {
          author_execution_id?: string | null;
          author_kind: string;
          author_module?: string | null;
          author_version?: string | null;
          content: Json;
          content_hash: string;
          created_at?: string;
          id?: string;
          kind: string;
          previous_version_id?: string | null;
          run_id: string;
          status: string;
          version: number;
          workspace_id: string;
        };
        Update: {
          author_execution_id?: string | null;
          author_kind?: string;
          author_module?: string | null;
          author_version?: string | null;
          content?: Json;
          content_hash?: string;
          created_at?: string;
          id?: string;
          kind?: string;
          previous_version_id?: string | null;
          run_id?: string;
          status?: string;
          version?: number;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'artifacts_previous_version_id_fkey';
            columns: ['previous_version_id'];
            isOneToOne: false;
            referencedRelation: 'artifacts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'artifacts_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      audit_logs: {
        Row: {
          action: string;
          actor: Json;
          created_at: string;
          id: number;
          metadata: Json;
          target_id: string | null;
          target_type: string | null;
          workspace_id: string;
        };
        Insert: {
          action: string;
          actor: Json;
          created_at?: string;
          id?: never;
          metadata?: Json;
          target_id?: string | null;
          target_type?: string | null;
          workspace_id: string;
        };
        Update: {
          action?: string;
          actor?: Json;
          created_at?: string;
          id?: never;
          metadata?: Json;
          target_id?: string | null;
          target_type?: string | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'audit_logs_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      claims: {
        Row: {
          attribute: string;
          confidence: string | null;
          confidence_score: number | null;
          conflict_state: string;
          conflicting_claim_ids: string[];
          created_at: string;
          fingerprint: string;
          id: string;
          newest_published_at: string | null;
          newest_retrieved_at: string;
          oldest_published_at: string | null;
          proposed_by_agent: string;
          proposed_by_execution_id: string;
          raw_value: string;
          run_id: string;
          statement: string;
          status: string;
          subject_company_id: string;
          subject_person_id: string | null;
          superseded_by: string | null;
          updated_at: string;
          value: Json;
          verification: Json;
          workspace_id: string;
        };
        Insert: {
          attribute: string;
          confidence?: string | null;
          confidence_score?: number | null;
          conflict_state?: string;
          conflicting_claim_ids?: string[];
          created_at?: string;
          fingerprint: string;
          id?: string;
          newest_published_at?: string | null;
          newest_retrieved_at: string;
          oldest_published_at?: string | null;
          proposed_by_agent: string;
          proposed_by_execution_id: string;
          raw_value: string;
          run_id: string;
          statement: string;
          status?: string;
          subject_company_id: string;
          subject_person_id?: string | null;
          superseded_by?: string | null;
          updated_at?: string;
          value: Json;
          verification?: Json;
          workspace_id: string;
        };
        Update: {
          attribute?: string;
          confidence?: string | null;
          confidence_score?: number | null;
          conflict_state?: string;
          conflicting_claim_ids?: string[];
          created_at?: string;
          fingerprint?: string;
          id?: string;
          newest_published_at?: string | null;
          newest_retrieved_at?: string;
          oldest_published_at?: string | null;
          proposed_by_agent?: string;
          proposed_by_execution_id?: string;
          raw_value?: string;
          run_id?: string;
          statement?: string;
          status?: string;
          subject_company_id?: string;
          subject_person_id?: string | null;
          superseded_by?: string | null;
          updated_at?: string;
          value?: Json;
          verification?: Json;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'claims_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'claims_subject_company_id_workspace_id_fkey';
            columns: ['subject_company_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'claims_subject_person_fkey';
            columns: ['subject_person_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'people';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'claims_superseded_by_fkey';
            columns: ['superseded_by'];
            isOneToOne: false;
            referencedRelation: 'claims';
            referencedColumns: ['id'];
          },
        ];
      };
      companies: {
        Row: {
          country: string | null;
          created_at: string;
          first_seen_run_id: string | null;
          id: string;
          name: string;
          normalized_name: string;
          primary_domain: string | null;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          country?: string | null;
          created_at?: string;
          first_seen_run_id?: string | null;
          id?: string;
          name: string;
          normalized_name: string;
          primary_domain?: string | null;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          country?: string | null;
          created_at?: string;
          first_seen_run_id?: string | null;
          id?: string;
          name?: string;
          normalized_name?: string;
          primary_domain?: string | null;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'companies_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      discovered_urls: {
        Row: {
          discovered_at: string;
          id: string;
          normalized_url: string;
          normalized_url_hash: string;
          origin: Json;
          origin_kind: string;
          run_id: string;
          url: string;
          workspace_id: string;
        };
        Insert: {
          discovered_at?: string;
          id?: string;
          normalized_url: string;
          normalized_url_hash: string;
          origin: Json;
          origin_kind: string;
          run_id: string;
          url: string;
          workspace_id: string;
        };
        Update: {
          discovered_at?: string;
          id?: string;
          normalized_url?: string;
          normalized_url_hash?: string;
          origin?: Json;
          origin_kind?: string;
          run_id?: string;
          url?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'discovered_urls_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      evidence: {
        Row: {
          claim_id: string;
          created_at: string;
          extracted_by_execution_id: string;
          grounding: string;
          id: string;
          judge_llm_call_id: string | null;
          judge_reason: string | null;
          judge_verdict: string | null;
          quote: string;
          quote_sha256: string;
          source_id: string;
          source_published_at: string | null;
          source_retrieved_at: string;
          spans: Json;
          stance: string;
          value_in_quote: boolean | null;
          workspace_id: string;
        };
        Insert: {
          claim_id: string;
          created_at?: string;
          extracted_by_execution_id: string;
          grounding: string;
          id?: string;
          judge_llm_call_id?: string | null;
          judge_reason?: string | null;
          judge_verdict?: string | null;
          quote: string;
          quote_sha256: string;
          source_id: string;
          source_published_at?: string | null;
          source_retrieved_at: string;
          spans?: Json;
          stance?: string;
          value_in_quote?: boolean | null;
          workspace_id: string;
        };
        Update: {
          claim_id?: string;
          created_at?: string;
          extracted_by_execution_id?: string;
          grounding?: string;
          id?: string;
          judge_llm_call_id?: string | null;
          judge_reason?: string | null;
          judge_verdict?: string | null;
          quote?: string;
          quote_sha256?: string;
          source_id?: string;
          source_published_at?: string | null;
          source_retrieved_at?: string;
          spans?: Json;
          stance?: string;
          value_in_quote?: boolean | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'evidence_claim_id_workspace_id_fkey';
            columns: ['claim_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'claims';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'evidence_judge_llm_call_id_fkey';
            columns: ['judge_llm_call_id'];
            isOneToOne: false;
            referencedRelation: 'llm_calls';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'evidence_source_id_workspace_id_fkey';
            columns: ['source_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'sources';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      finding_claims: {
        Row: {
          claim_id: string;
          finding_id: string;
          role: string;
          workspace_id: string;
        };
        Insert: {
          claim_id: string;
          finding_id: string;
          role: string;
          workspace_id: string;
        };
        Update: {
          claim_id?: string;
          finding_id?: string;
          role?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'finding_claims_claim_id_workspace_id_fkey';
            columns: ['claim_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'claims';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'finding_claims_finding_id_workspace_id_fkey';
            columns: ['finding_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'findings';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      findings: {
        Row: {
          author_execution_id: string | null;
          author_kind: string;
          author_module: string | null;
          author_version: string | null;
          created_at: string;
          id: string;
          kind: string;
          label: string;
          run_id: string;
          score: Json | null;
          statement: string;
          subject_company_id: string | null;
          subject_kind: string;
          workspace_id: string;
        };
        Insert: {
          author_execution_id?: string | null;
          author_kind: string;
          author_module?: string | null;
          author_version?: string | null;
          created_at?: string;
          id?: string;
          kind: string;
          label: string;
          run_id: string;
          score?: Json | null;
          statement: string;
          subject_company_id?: string | null;
          subject_kind: string;
          workspace_id: string;
        };
        Update: {
          author_execution_id?: string | null;
          author_kind?: string;
          author_module?: string | null;
          author_version?: string | null;
          created_at?: string;
          id?: string;
          kind?: string;
          label?: string;
          run_id?: string;
          score?: Json | null;
          statement?: string;
          subject_company_id?: string | null;
          subject_kind?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'findings_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'findings_subject_company_id_workspace_id_fkey';
            columns: ['subject_company_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      llm_calls: {
        Row: {
          cache_read_tokens: number | null;
          cache_status: string;
          cache_write_tokens: number | null;
          cost_usd_micros: number;
          execution_id: string;
          failure: Json | null;
          id: string;
          input_tokens: number;
          latency_ms: number;
          model: string;
          output_tokens: number;
          prompt_version: string;
          provider: string;
          provider_account: string;
          reasoning_tokens: number | null;
          request_hash: string;
          retry_count: number;
          route: string;
          routing_config_version: string;
          run_id: string;
          seq: number;
          started_at: string;
          stop_reason: string;
          task_id: string;
          workspace_id: string;
        };
        Insert: {
          cache_read_tokens?: number | null;
          cache_status: string;
          cache_write_tokens?: number | null;
          cost_usd_micros: number;
          execution_id: string;
          failure?: Json | null;
          id: string;
          input_tokens: number;
          latency_ms: number;
          model: string;
          output_tokens: number;
          prompt_version: string;
          provider: string;
          provider_account: string;
          reasoning_tokens?: number | null;
          request_hash: string;
          retry_count: number;
          route: string;
          routing_config_version: string;
          run_id: string;
          seq: number;
          started_at: string;
          stop_reason: string;
          task_id: string;
          workspace_id: string;
        };
        Update: {
          cache_read_tokens?: number | null;
          cache_status?: string;
          cache_write_tokens?: number | null;
          cost_usd_micros?: number;
          execution_id?: string;
          failure?: Json | null;
          id?: string;
          input_tokens?: number;
          latency_ms?: number;
          model?: string;
          output_tokens?: number;
          prompt_version?: string;
          provider?: string;
          provider_account?: string;
          reasoning_tokens?: number | null;
          request_hash?: string;
          retry_count?: number;
          route?: string;
          routing_config_version?: string;
          run_id?: string;
          seq?: number;
          started_at?: string;
          stop_reason?: string;
          task_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'llm_calls_execution_id_workspace_id_fkey';
            columns: ['execution_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'agent_executions';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'llm_calls_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      people: {
        Row: {
          created_at: string;
          first_seen_run_id: string | null;
          full_name: string;
          id: string;
          normalized_name: string;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          first_seen_run_id?: string | null;
          full_name: string;
          id?: string;
          normalized_name: string;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          first_seen_run_id?: string | null;
          full_name?: string;
          id?: string;
          normalized_name?: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'people_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      projects: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          name: string;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name: string;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name?: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'projects_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      research_gaps: {
        Row: {
          attempts: number;
          attribute: string;
          company_id: string;
          created_at: string;
          id: string;
          note: string | null;
          reason: string;
          resolved_at: string | null;
          run_id: string;
          status: string;
          workspace_id: string;
        };
        Insert: {
          attempts?: number;
          attribute: string;
          company_id: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          reason: string;
          resolved_at?: string | null;
          run_id: string;
          status?: string;
          workspace_id: string;
        };
        Update: {
          attempts?: number;
          attribute?: string;
          company_id?: string;
          created_at?: string;
          id?: string;
          note?: string | null;
          reason?: string;
          resolved_at?: string | null;
          run_id?: string;
          status?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'research_gaps_company_id_workspace_id_fkey';
            columns: ['company_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'companies';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'research_gaps_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      run_events: {
        Row: {
          actor: Json;
          data: Json;
          occurred_at: string;
          refs: Json;
          run_id: string;
          seq: number;
          type: string;
          workspace_id: string;
        };
        Insert: {
          actor: Json;
          data?: Json;
          occurred_at?: string;
          refs?: Json;
          run_id: string;
          seq: number;
          type: string;
          workspace_id: string;
        };
        Update: {
          actor?: Json;
          data?: Json;
          occurred_at?: string;
          refs?: Json;
          run_id?: string;
          seq?: number;
          type?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'run_events_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      runs: {
        Row: {
          brief: Json | null;
          budget: Json;
          budget_blocked: boolean;
          cancel_requested: boolean;
          created_at: string;
          created_by: string;
          failure: Json | null;
          finished_at: string | null;
          id: string;
          last_event_seq: number;
          objective: string;
          pause_reason: string | null;
          pause_requested: boolean;
          project_id: string;
          spend_cost_usd_micros: number;
          spend_llm_input_tokens: number;
          spend_llm_output_tokens: number;
          spend_tool_calls: number;
          started_at: string | null;
          status: string;
          updated_at: string;
          workflow: string;
          workflow_version: number;
          workspace_id: string;
        };
        Insert: {
          brief?: Json | null;
          budget: Json;
          budget_blocked?: boolean;
          cancel_requested?: boolean;
          created_at?: string;
          created_by: string;
          failure?: Json | null;
          finished_at?: string | null;
          id?: string;
          last_event_seq?: number;
          objective: string;
          pause_reason?: string | null;
          pause_requested?: boolean;
          project_id: string;
          spend_cost_usd_micros?: number;
          spend_llm_input_tokens?: number;
          spend_llm_output_tokens?: number;
          spend_tool_calls?: number;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          workflow: string;
          workflow_version: number;
          workspace_id: string;
        };
        Update: {
          brief?: Json | null;
          budget?: Json;
          budget_blocked?: boolean;
          cancel_requested?: boolean;
          created_at?: string;
          created_by?: string;
          failure?: Json | null;
          finished_at?: string | null;
          id?: string;
          last_event_seq?: number;
          objective?: string;
          pause_reason?: string | null;
          pause_requested?: boolean;
          project_id?: string;
          spend_cost_usd_micros?: number;
          spend_llm_input_tokens?: number;
          spend_llm_output_tokens?: number;
          spend_tool_calls?: number;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          workflow?: string;
          workflow_version?: number;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'runs_project_id_workspace_id_fkey';
            columns: ['project_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'runs_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      sources: {
        Row: {
          canonical_url: string | null;
          content_sha256: string;
          created_at: string;
          discovered_url_id: string | null;
          extraction_method: string;
          extractor_version: string;
          fetched_by_tool_call_id: string;
          final_url: string;
          final_url_hash: string;
          flags: string[];
          host: string;
          http: Json | null;
          id: string;
          language: string | null;
          origin: Json;
          published_at: string | null;
          published_at_method: string;
          publisher: string | null;
          raw_sha256: string;
          registrable_domain: string;
          requested_url: string;
          retrieved_at: string;
          source_type: string;
          text: string;
          text_length: number;
          tier: string;
          title: string | null;
          truncated: boolean;
          workspace_id: string;
        };
        Insert: {
          canonical_url?: string | null;
          content_sha256: string;
          created_at?: string;
          discovered_url_id?: string | null;
          extraction_method: string;
          extractor_version: string;
          fetched_by_tool_call_id: string;
          final_url: string;
          final_url_hash: string;
          flags?: string[];
          host: string;
          http?: Json | null;
          id?: string;
          language?: string | null;
          origin: Json;
          published_at?: string | null;
          published_at_method: string;
          publisher?: string | null;
          raw_sha256: string;
          registrable_domain: string;
          requested_url: string;
          retrieved_at: string;
          source_type: string;
          text: string;
          text_length: number;
          tier: string;
          title?: string | null;
          truncated: boolean;
          workspace_id: string;
        };
        Update: {
          canonical_url?: string | null;
          content_sha256?: string;
          created_at?: string;
          discovered_url_id?: string | null;
          extraction_method?: string;
          extractor_version?: string;
          fetched_by_tool_call_id?: string;
          final_url?: string;
          final_url_hash?: string;
          flags?: string[];
          host?: string;
          http?: Json | null;
          id?: string;
          language?: string | null;
          origin?: Json;
          published_at?: string | null;
          published_at_method?: string;
          publisher?: string | null;
          raw_sha256?: string;
          registrable_domain?: string;
          requested_url?: string;
          retrieved_at?: string;
          source_type?: string;
          text?: string;
          text_length?: number;
          tier?: string;
          title?: string | null;
          truncated?: boolean;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'sources_discovered_url_id_fkey';
            columns: ['discovered_url_id'];
            isOneToOne: false;
            referencedRelation: 'discovered_urls';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'sources_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      task_dependencies: {
        Row: {
          created_at: string;
          depends_on_task_id: string;
          mode: string;
          run_id: string;
          task_id: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          depends_on_task_id: string;
          mode: string;
          run_id: string;
          task_id: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          depends_on_task_id?: string;
          mode?: string;
          run_id?: string;
          task_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'task_dependencies_depends_on_task_id_run_id_fkey';
            columns: ['depends_on_task_id', 'run_id'];
            isOneToOne: false;
            referencedRelation: 'tasks';
            referencedColumns: ['id', 'run_id'];
          },
          {
            foreignKeyName: 'task_dependencies_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'task_dependencies_task_id_run_id_fkey';
            columns: ['task_id', 'run_id'];
            isOneToOne: false;
            referencedRelation: 'tasks';
            referencedColumns: ['id', 'run_id'];
          },
        ];
      };
      tasks: {
        Row: {
          attempt: number;
          created_at: string;
          finished_at: string | null;
          heartbeat_at: string | null;
          id: string;
          idempotency_key: string;
          input: Json;
          kind: string;
          last_failure: Json | null;
          lease_expires_at: string | null;
          lease_owner: string | null;
          lease_token: string | null;
          max_attempts: number;
          output: Json | null;
          parent_task_id: string | null;
          priority: number;
          run_after: string;
          run_id: string;
          started_at: string | null;
          status: string;
          subject_company_id: string | null;
          type: string;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          attempt?: number;
          created_at?: string;
          finished_at?: string | null;
          heartbeat_at?: string | null;
          id?: string;
          idempotency_key: string;
          input: Json;
          kind: string;
          last_failure?: Json | null;
          lease_expires_at?: string | null;
          lease_owner?: string | null;
          lease_token?: string | null;
          max_attempts: number;
          output?: Json | null;
          parent_task_id?: string | null;
          priority?: number;
          run_after?: string;
          run_id: string;
          started_at?: string | null;
          status?: string;
          subject_company_id?: string | null;
          type: string;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          attempt?: number;
          created_at?: string;
          finished_at?: string | null;
          heartbeat_at?: string | null;
          id?: string;
          idempotency_key?: string;
          input?: Json;
          kind?: string;
          last_failure?: Json | null;
          lease_expires_at?: string | null;
          lease_owner?: string | null;
          lease_token?: string | null;
          max_attempts?: number;
          output?: Json | null;
          parent_task_id?: string | null;
          priority?: number;
          run_after?: string;
          run_id?: string;
          started_at?: string | null;
          status?: string;
          subject_company_id?: string | null;
          type?: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tasks_parent_task_id_fkey';
            columns: ['parent_task_id'];
            isOneToOne: false;
            referencedRelation: 'tasks';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tasks_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      tool_calls: {
        Row: {
          arguments: Json;
          arguments_hash: string;
          cache_hit: boolean;
          cost_usd_micros: number;
          created_source_ids: string[];
          error_code: string | null;
          execution_id: string;
          id: string;
          latency_ms: number;
          model_tool_call_id: string | null;
          provider: string | null;
          run_id: string;
          started_at: string;
          status: string;
          task_id: string;
          tool: string;
          upstream_latency_ms: number | null;
          workspace_id: string;
        };
        Insert: {
          arguments: Json;
          arguments_hash: string;
          cache_hit?: boolean;
          cost_usd_micros?: number;
          created_source_ids?: string[];
          error_code?: string | null;
          execution_id: string;
          id: string;
          latency_ms: number;
          model_tool_call_id?: string | null;
          provider?: string | null;
          run_id: string;
          started_at: string;
          status: string;
          task_id: string;
          tool: string;
          upstream_latency_ms?: number | null;
          workspace_id: string;
        };
        Update: {
          arguments?: Json;
          arguments_hash?: string;
          cache_hit?: boolean;
          cost_usd_micros?: number;
          created_source_ids?: string[];
          error_code?: string | null;
          execution_id?: string;
          id?: string;
          latency_ms?: number;
          model_tool_call_id?: string | null;
          provider?: string | null;
          run_id?: string;
          started_at?: string;
          status?: string;
          task_id?: string;
          tool?: string;
          upstream_latency_ms?: number | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tool_calls_execution_id_workspace_id_fkey';
            columns: ['execution_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'agent_executions';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'tool_calls_run_id_workspace_id_fkey';
            columns: ['run_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'runs';
            referencedColumns: ['id', 'workspace_id'];
          },
        ];
      };
      workspace_members: {
        Row: {
          created_at: string;
          role: string;
          user_id: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          role: string;
          user_id: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          role?: string;
          user_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'workspace_members_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      workspaces: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          slug: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          slug: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          slug?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    keyof (DefaultSchema['Tables'] & DefaultSchema['Views']) | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;

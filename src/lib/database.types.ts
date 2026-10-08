// Generated from the database schema by scripts/gen-db-types.py (same shape as `supabase gen types typescript`).
// Regenerate after changing migrations:
//   PSQL="psql <connection>" python3 scripts/gen-db-types.py > src/lib/database.types.ts

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      accounts: {
        Row: {
          account_type: string;
          active: boolean;
          autopay_account_id: string | null;
          autopay_enabled: boolean;
          available_balance: number | null;
          balance_as_of: string | null;
          created_at: string;
          credit_limit: number | null;
          currency: string;
          current_balance: number;
          id: string;
          institution: string | null;
          is_overdue: boolean | null;
          last_four: string | null;
          last_payment_amount: number | null;
          last_payment_date: string | null;
          last_statement_date: string | null;
          minimum_payment: number | null;
          name: string;
          next_payment_due_date: string | null;
          notes: string | null;
          payment_due_day: number | null;
          plaid_account_id: string | null;
          plaid_item_id: string | null;
          sort_order: number;
          statement_balance: number | null;
          statement_close_day: number | null;
          sync_from: string | null;
          track_transactions: boolean;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          account_type?: string;
          active?: boolean;
          autopay_account_id?: string | null;
          autopay_enabled?: boolean;
          available_balance?: number | null;
          balance_as_of?: string | null;
          created_at?: string;
          credit_limit?: number | null;
          currency?: string;
          current_balance?: number;
          id?: string;
          institution?: string | null;
          is_overdue?: boolean | null;
          last_four?: string | null;
          last_payment_amount?: number | null;
          last_payment_date?: string | null;
          last_statement_date?: string | null;
          minimum_payment?: number | null;
          name: string;
          next_payment_due_date?: string | null;
          notes?: string | null;
          payment_due_day?: number | null;
          plaid_account_id?: string | null;
          plaid_item_id?: string | null;
          sort_order?: number;
          statement_balance?: number | null;
          statement_close_day?: number | null;
          sync_from?: string | null;
          track_transactions?: boolean;
          updated_at?: string;
          workspace_id?: string;
        };
        Update: {
          account_type?: string;
          active?: boolean;
          autopay_account_id?: string | null;
          autopay_enabled?: boolean;
          available_balance?: number | null;
          balance_as_of?: string | null;
          created_at?: string;
          credit_limit?: number | null;
          currency?: string;
          current_balance?: number;
          id?: string;
          institution?: string | null;
          is_overdue?: boolean | null;
          last_four?: string | null;
          last_payment_amount?: number | null;
          last_payment_date?: string | null;
          last_statement_date?: string | null;
          minimum_payment?: number | null;
          name?: string;
          next_payment_due_date?: string | null;
          notes?: string | null;
          payment_due_day?: number | null;
          plaid_account_id?: string | null;
          plaid_item_id?: string | null;
          sort_order?: number;
          statement_balance?: number | null;
          statement_close_day?: number | null;
          sync_from?: string | null;
          track_transactions?: boolean;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "accounts_plaid_item_id_fkey";
            columns: ["plaid_item_id"];
            isOneToOne: false;
            referencedRelation: "plaid_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_workspace_id_autopay_account_id_fkey";
            columns: ["workspace_id", "autopay_account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "accounts_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_reminders: {
        Row: {
          account_id: string | null;
          amount: number | null;
          completed: boolean;
          created_at: string;
          event_type: string;
          id: string;
          notes: string | null;
          reminder_date: string;
          title: string;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          account_id?: string | null;
          amount?: number | null;
          completed?: boolean;
          created_at?: string;
          event_type?: string;
          id?: string;
          notes?: string | null;
          reminder_date: string;
          title: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Update: {
          account_id?: string | null;
          amount?: number | null;
          completed?: boolean;
          created_at?: string;
          event_type?: string;
          id?: string;
          notes?: string | null;
          reminder_date?: string;
          title?: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_reminders_workspace_id_account_id_fkey";
            columns: ["workspace_id", "account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "calendar_reminders_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      categories: {
        Row: {
          active: boolean;
          category_type: string;
          code: string | null;
          color: string;
          created_at: string;
          icon: string | null;
          id: string;
          name: string;
          parent_category_id: string | null;
          sort_order: number;
          tax_line: string | null;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          active?: boolean;
          category_type?: string;
          code?: string | null;
          color?: string;
          created_at?: string;
          icon?: string | null;
          id?: string;
          name: string;
          parent_category_id?: string | null;
          sort_order?: number;
          tax_line?: string | null;
          updated_at?: string;
          workspace_id?: string;
        };
        Update: {
          active?: boolean;
          category_type?: string;
          code?: string | null;
          color?: string;
          created_at?: string;
          icon?: string | null;
          id?: string;
          name?: string;
          parent_category_id?: string | null;
          sort_order?: number;
          tax_line?: string | null;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "categories_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "categories_workspace_id_parent_category_id_fkey";
            columns: ["workspace_id", "parent_category_id"];
            isOneToOne: false;
            referencedRelation: "categories";
            referencedColumns: ["workspace_id", "id"];
          },
        ];
      };
      categorization_rules: {
        Row: {
          actions: Json;
          active: boolean;
          apply_on_import: boolean;
          conditions: Json;
          created_at: string;
          id: string;
          name: string;
          priority: number;
          times_applied: number;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          actions: Json;
          active?: boolean;
          apply_on_import?: boolean;
          conditions: Json;
          created_at?: string;
          id?: string;
          name: string;
          priority?: number;
          times_applied?: number;
          updated_at?: string;
          workspace_id?: string;
        };
        Update: {
          actions?: Json;
          active?: boolean;
          apply_on_import?: boolean;
          conditions?: Json;
          created_at?: string;
          id?: string;
          name?: string;
          priority?: number;
          times_applied?: number;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "categorization_rules_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      coinbase_connections: {
        Row: {
          account_id: string | null;
          created_at: string;
          id: string;
          key_name: string;
          last_sync_error: string | null;
          last_synced_at: string | null;
          private_key_enc: string;
          status: string;
          updated_at: string;
          user_id: string;
          wallets: Json;
        };
        Insert: {
          account_id?: string | null;
          created_at?: string;
          id?: string;
          key_name: string;
          last_sync_error?: string | null;
          last_synced_at?: string | null;
          private_key_enc: string;
          status?: string;
          updated_at?: string;
          user_id?: string;
          wallets?: Json;
        };
        Update: {
          account_id?: string | null;
          created_at?: string;
          id?: string;
          key_name?: string;
          last_sync_error?: string | null;
          last_synced_at?: string | null;
          private_key_enc?: string;
          status?: string;
          updated_at?: string;
          user_id?: string;
          wallets?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "coinbase_connections_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      import_rows: {
        Row: {
          created_at: string;
          id: string;
          import_id: string;
          message: string | null;
          raw: Json;
          row_number: number;
          status: string;
          transaction_id: string | null;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          import_id: string;
          message?: string | null;
          raw: Json;
          row_number: number;
          status: string;
          transaction_id?: string | null;
          workspace_id?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          import_id?: string;
          message?: string | null;
          raw?: Json;
          row_number?: number;
          status?: string;
          transaction_id?: string | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "import_rows_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "import_rows_workspace_id_import_id_fkey";
            columns: ["workspace_id", "import_id"];
            isOneToOne: false;
            referencedRelation: "imports";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "import_rows_workspace_id_transaction_id_fkey";
            columns: ["workspace_id", "transaction_id"];
            isOneToOne: false;
            referencedRelation: "transactions";
            referencedColumns: ["workspace_id", "id"];
          },
        ];
      };
      imports: {
        Row: {
          column_mapping: Json;
          completed_at: string | null;
          created_at: string;
          duplicate_count: number;
          error_count: number;
          file_size: number | null;
          filename: string;
          id: string;
          imported_count: number;
          options: Json;
          row_count: number;
          skipped_count: number;
          status: string;
          workspace_id: string;
        };
        Insert: {
          column_mapping?: Json;
          completed_at?: string | null;
          created_at?: string;
          duplicate_count?: number;
          error_count?: number;
          file_size?: number | null;
          filename: string;
          id?: string;
          imported_count?: number;
          options?: Json;
          row_count?: number;
          skipped_count?: number;
          status?: string;
          workspace_id?: string;
        };
        Update: {
          column_mapping?: Json;
          completed_at?: string | null;
          created_at?: string;
          duplicate_count?: number;
          error_count?: number;
          file_size?: number | null;
          filename?: string;
          id?: string;
          imported_count?: number;
          options?: Json;
          row_count?: number;
          skipped_count?: number;
          status?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "imports_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      plaid_items: {
        Row: {
          access_token_enc: string;
          created_at: string;
          cursor: string | null;
          error_code: string | null;
          id: string;
          institution_id: string | null;
          institution_name: string | null;
          item_id: string;
          last_sync_error: string | null;
          last_synced_at: string | null;
          liabilities_status: string | null;
          plaid_accounts: Json;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          access_token_enc: string;
          created_at?: string;
          cursor?: string | null;
          error_code?: string | null;
          id?: string;
          institution_id?: string | null;
          institution_name?: string | null;
          item_id: string;
          last_sync_error?: string | null;
          last_synced_at?: string | null;
          liabilities_status?: string | null;
          plaid_accounts?: Json;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Update: {
          access_token_enc?: string;
          created_at?: string;
          cursor?: string | null;
          error_code?: string | null;
          id?: string;
          institution_id?: string | null;
          institution_name?: string | null;
          item_id?: string;
          last_sync_error?: string | null;
          last_synced_at?: string | null;
          liabilities_status?: string | null;
          plaid_accounts?: Json;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      recurring_items: {
        Row: {
          account_id: string | null;
          active: boolean;
          amount_type: string;
          category_id: string | null;
          created_at: string;
          end_date: string | null;
          expected_amount: number;
          frequency: string;
          id: string;
          interval_value: number;
          match_mode: string;
          match_patterns: string[];
          merchant_pattern: string | null;
          name: string;
          next_expected_date: string;
          notes: string | null;
          recurring_type: string;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          account_id?: string | null;
          active?: boolean;
          amount_type?: string;
          category_id?: string | null;
          created_at?: string;
          end_date?: string | null;
          expected_amount?: number;
          frequency?: string;
          id?: string;
          interval_value?: number;
          match_mode?: string;
          match_patterns?: string[];
          merchant_pattern?: string | null;
          name: string;
          next_expected_date: string;
          notes?: string | null;
          recurring_type?: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Update: {
          account_id?: string | null;
          active?: boolean;
          amount_type?: string;
          category_id?: string | null;
          created_at?: string;
          end_date?: string | null;
          expected_amount?: number;
          frequency?: string;
          id?: string;
          interval_value?: number;
          match_mode?: string;
          match_patterns?: string[];
          merchant_pattern?: string | null;
          name?: string;
          next_expected_date?: string;
          notes?: string | null;
          recurring_type?: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "recurring_items_workspace_id_account_id_fkey";
            columns: ["workspace_id", "account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "recurring_items_workspace_id_category_id_fkey";
            columns: ["workspace_id", "category_id"];
            isOneToOne: false;
            referencedRelation: "categories";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "recurring_items_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      recurring_occurrences: {
        Row: {
          created_at: string;
          expected_amount: number | null;
          expected_date: string;
          id: string;
          notes: string | null;
          recurring_item_id: string;
          status: string;
          transaction_id: string | null;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          expected_amount?: number | null;
          expected_date: string;
          id?: string;
          notes?: string | null;
          recurring_item_id: string;
          status?: string;
          transaction_id?: string | null;
          updated_at?: string;
          workspace_id?: string;
        };
        Update: {
          created_at?: string;
          expected_amount?: number | null;
          expected_date?: string;
          id?: string;
          notes?: string | null;
          recurring_item_id?: string;
          status?: string;
          transaction_id?: string | null;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "recurring_occurrences_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "recurring_occurrences_workspace_id_recurring_item_id_fkey";
            columns: ["workspace_id", "recurring_item_id"];
            isOneToOne: false;
            referencedRelation: "recurring_items";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "recurring_occurrences_workspace_id_transaction_id_fkey";
            columns: ["workspace_id", "transaction_id"];
            isOneToOne: false;
            referencedRelation: "transactions";
            referencedColumns: ["workspace_id", "id"];
          },
        ];
      };
      tags: {
        Row: {
          color: string;
          created_at: string;
          id: string;
          name: string;
          workspace_id: string;
        };
        Insert: {
          color?: string;
          created_at?: string;
          id?: string;
          name: string;
          workspace_id?: string;
        };
        Update: {
          color?: string;
          created_at?: string;
          id?: string;
          name?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tags_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      transaction_splits: {
        Row: {
          amount: number;
          category_id: string | null;
          created_at: string;
          id: string;
          notes: string | null;
          sort_order: number;
          transaction_id: string;
          workspace_id: string;
        };
        Insert: {
          amount: number;
          category_id?: string | null;
          created_at?: string;
          id?: string;
          notes?: string | null;
          sort_order?: number;
          transaction_id: string;
          workspace_id?: string;
        };
        Update: {
          amount?: number;
          category_id?: string | null;
          created_at?: string;
          id?: string;
          notes?: string | null;
          sort_order?: number;
          transaction_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "transaction_splits_workspace_id_category_id_fkey";
            columns: ["workspace_id", "category_id"];
            isOneToOne: false;
            referencedRelation: "categories";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "transaction_splits_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "transaction_splits_workspace_id_transaction_id_fkey";
            columns: ["workspace_id", "transaction_id"];
            isOneToOne: false;
            referencedRelation: "transactions";
            referencedColumns: ["workspace_id", "id"];
          },
        ];
      };
      transaction_tags: {
        Row: {
          created_at: string;
          tag_id: string;
          transaction_id: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          tag_id: string;
          transaction_id: string;
          workspace_id?: string;
        };
        Update: {
          created_at?: string;
          tag_id?: string;
          transaction_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "transaction_tags_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "transaction_tags_workspace_id_tag_id_fkey";
            columns: ["workspace_id", "tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "transaction_tags_workspace_id_transaction_id_fkey";
            columns: ["workspace_id", "transaction_id"];
            isOneToOne: false;
            referencedRelation: "transactions";
            referencedColumns: ["workspace_id", "id"];
          },
        ];
      };
      transactions: {
        Row: {
          account_id: string;
          amount: number;
          amount_abs: number | null;
          category_id: string | null;
          coinbase_transaction_id: string | null;
          created_at: string;
          currency: string;
          excluded: boolean;
          external_transaction_id: string | null;
          id: string;
          import_hash: string | null;
          import_id: string | null;
          is_recurring: boolean | null;
          merchant_name: string;
          notes: string | null;
          original_description: string | null;
          plaid_transaction_id: string | null;
          posted_date: string | null;
          recurring_item_id: string | null;
          review_status: string;
          reviewed_at: string | null;
          status: string;
          transaction_date: string;
          transaction_type: string;
          transfer_group_id: string | null;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          account_id: string;
          amount: number;
          amount_abs?: number | null;
          category_id?: string | null;
          coinbase_transaction_id?: string | null;
          created_at?: string;
          currency?: string;
          excluded?: boolean;
          external_transaction_id?: string | null;
          id?: string;
          import_hash?: string | null;
          import_id?: string | null;
          is_recurring?: boolean | null;
          merchant_name: string;
          notes?: string | null;
          original_description?: string | null;
          plaid_transaction_id?: string | null;
          posted_date?: string | null;
          recurring_item_id?: string | null;
          review_status?: string;
          reviewed_at?: string | null;
          status?: string;
          transaction_date: string;
          transaction_type?: string;
          transfer_group_id?: string | null;
          updated_at?: string;
          workspace_id?: string;
        };
        Update: {
          account_id?: string;
          amount?: number;
          amount_abs?: number | null;
          category_id?: string | null;
          coinbase_transaction_id?: string | null;
          created_at?: string;
          currency?: string;
          excluded?: boolean;
          external_transaction_id?: string | null;
          id?: string;
          import_hash?: string | null;
          import_id?: string | null;
          is_recurring?: boolean | null;
          merchant_name?: string;
          notes?: string | null;
          original_description?: string | null;
          plaid_transaction_id?: string | null;
          posted_date?: string | null;
          recurring_item_id?: string | null;
          review_status?: string;
          reviewed_at?: string | null;
          status?: string;
          transaction_date?: string;
          transaction_type?: string;
          transfer_group_id?: string | null;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "transactions_workspace_id_account_id_fkey";
            columns: ["workspace_id", "account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "transactions_workspace_id_category_id_fkey";
            columns: ["workspace_id", "category_id"];
            isOneToOne: false;
            referencedRelation: "categories";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "transactions_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "transactions_workspace_id_import_id_fkey";
            columns: ["workspace_id", "import_id"];
            isOneToOne: false;
            referencedRelation: "imports";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "transactions_workspace_id_recurring_item_id_fkey";
            columns: ["workspace_id", "recurring_item_id"];
            isOneToOne: false;
            referencedRelation: "recurring_items";
            referencedColumns: ["workspace_id", "id"];
          },
          {
            foreignKeyName: "transactions_workspace_id_transfer_group_id_fkey";
            columns: ["workspace_id", "transfer_group_id"];
            isOneToOne: false;
            referencedRelation: "transfer_groups";
            referencedColumns: ["workspace_id", "id"];
          },
        ];
      };
      transfer_groups: {
        Row: {
          created_at: string;
          id: string;
          note: string | null;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          note?: string | null;
          workspace_id?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          note?: string | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "transfer_groups_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_invites: {
        Row: {
          accepted_at: string | null;
          accepted_by: string | null;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by: string | null;
          role: string;
          token: string;
          workspace_id: string;
        };
        Insert: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          created_at?: string;
          email: string;
          expires_at?: string;
          id?: string;
          invited_by?: string | null;
          role?: string;
          token?: string;
          workspace_id: string;
        };
        Update: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          created_at?: string;
          email?: string;
          expires_at?: string;
          id?: string;
          invited_by?: string | null;
          role?: string;
          token?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_invites_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
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
          role?: string;
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
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspaces: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          kind: string;
          name: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind?: string;
          name: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind?: string;
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      countable_entries: {
        Row: {
          account_id: string | null;
          amount: number | null;
          category_id: string | null;
          excluded: boolean | null;
          merchant_name: string | null;
          recurring_item_id: string | null;
          split_id: string | null;
          transaction_date: string | null;
          transaction_id: string | null;
          transaction_type: string | null;
          workspace_id: string | null;
        };
        Relationships: [];
      };
      ledger_entries: {
        Row: {
          account_id: string | null;
          amount: number | null;
          category_id: string | null;
          excluded: boolean | null;
          merchant_name: string | null;
          recurring_item_id: string | null;
          split_id: string | null;
          transaction_date: string | null;
          transaction_id: string | null;
          transaction_type: string | null;
          workspace_id: string | null;
        };
        Relationships: [];
      };
      pnl_entries: {
        Row: {
          account_id: string | null;
          amount: number | null;
          category_id: string | null;
          excluded: boolean | null;
          merchant_name: string | null;
          pnl_class: string | null;
          recurring_item_id: string | null;
          split_id: string | null;
          transaction_date: string | null;
          transaction_id: string | null;
          transaction_type: string | null;
          workspace_id: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      accept_workspace_invite: { Args: { p_token: string }; Returns: string };
      apply_categorization_rules: {
        Args: { p_transaction_ids?: string[]; p_rule_id?: string; p_only_unreviewed?: boolean; p_import_only?: boolean };
        Returns: number;
      };
      apply_categorization_rules_as: { Args: { p_user_id: string; p_transaction_ids: string[] }; Returns: number };
      auto_link_recurring: { Args: { p_transaction_ids: string[] }; Returns: number };
      auto_link_recurring_as: { Args: { p_user_id: string; p_transaction_ids: string[] }; Returns: number };
      bulk_add_tag: { Args: { p_ids: string[]; p_tag_id: string }; Returns: number };
      bulk_delete_transactions: { Args: { p_ids: string[] }; Returns: number };
      bulk_update_transactions: { Args: { p_ids: string[]; p_patch: Json }; Returns: number };
      business_summary: {
        Args: { p_start: string; p_end: string };
        Returns: {
          revenue: number;
          cost_of_goods: number;
          operating_expenses: number;
          owner_contributions: number;
          owner_draws: number;
          transaction_count: number;
        }[];
      };
      cashflow_summary: {
        Args: { p_start: string; p_end: string; p_account_id?: string };
        Returns: { spending: number; income: number; transaction_count: number }[];
      };
      copy_account_to_workspace: { Args: { p_account_id: string; p_target_ws: string }; Returns: string };
      create_workspace: { Args: { p_name: string; p_kind?: string }; Returns: string };
      delete_all_my_data: { Args: { p_confirm: string }; Returns: undefined };
      delete_workspace: { Args: { p_workspace_id: string; p_confirm_name: string }; Returns: undefined };
      ensure_personal_workspace: { Args: { p_name?: string }; Returns: string };
      invite_to_workspace: { Args: { p_workspace_id: string; p_email: string; p_role?: string }; Returns: { id: string; token: string }[] };
      link_recurring_transactions: { Args: { p_recurring_item_id: string }; Returns: number };
      link_transfer: { Args: { p_ids: string[]; p_type?: string }; Returns: string };
      list_workspace_members: { Args: { p_workspace_id: string }; Returns: { user_id: string; email: string; role: string; joined_at: string }[] };
      monthly_cashflow: { Args: { p_end: string; p_months?: number }; Returns: { month: string; spending: number; income: number }[] };
      monthly_pnl: {
        Args: { p_end: string; p_months?: number };
        Returns: { month: string; revenue: number; cost_of_goods: number; operating_expenses: number }[];
      };
      move_account_to_workspace: { Args: { p_account_id: string; p_target_ws: string }; Returns: string };
      my_workspace_invites: {
        Args: never;
        Returns: {
          id: string;
          token: string;
          workspace_id: string;
          workspace_name: string;
          workspace_kind: string;
          role: string;
          invited_by_email: string;
          expires_at: string;
        }[];
      };
      my_workspaces: { Args: never; Returns: { id: string; name: string; kind: string; role: string; created_at: string }[] };
      personal_workspace_of: { Args: { p_user_id: string }; Returns: string };
      pnl_by_category: {
        Args: { p_start: string; p_end: string };
        Returns: { category_id: string; pnl_class: string; amount: number; transaction_count: number }[];
      };
      preview_recurring_matches: { Args: { p_patterns: string[]; p_mode?: string; p_account_id?: string; p_recurring_item_id?: string }; Returns: Json };
      preview_rule_matches: { Args: { p_conditions: Json; p_only_unreviewed?: boolean }; Returns: number };
      recurring_text_matches: { Args: { p_patterns: string[]; p_mode: string; p_merchant: string; p_description: string }; Returns: boolean };
      remove_account_copy: { Args: { p_account_id: string }; Returns: undefined };
      remove_workspace_member: { Args: { p_workspace_id: string; p_user_id: string }; Returns: undefined };
      request_or_personal_workspace: { Args: never; Returns: string };
      revoke_workspace_invite: { Args: { p_invite_id: string }; Returns: undefined };
      search_transactions: { Args: { q?: string }; Returns: Database["public"]["Tables"]["transactions"]["Row"][] };
      seed_default_categories: { Args: never; Returns: number };
      set_transaction_splits: { Args: { p_transaction_id: string; p_splits: Json }; Returns: undefined };
      set_workspace_member_role: { Args: { p_workspace_id: string; p_user_id: string; p_role: string }; Returns: undefined };
      spending_by_category: {
        Args: { p_start: string; p_end: string; p_account_id?: string };
        Returns: { category_id: string; amount: number; transaction_count: number }[];
      };
      unlink_transfer: { Args: { p_group_id: string }; Returns: undefined };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database["public"];

export type Tables<T extends keyof (PublicSchema["Tables"] & PublicSchema["Views"])> = (PublicSchema["Tables"] & PublicSchema["Views"])[T] extends {
  Row: infer R;
}
  ? R
  : never;

export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T] extends { Insert: infer I } ? I : never;

export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T] extends { Update: infer U } ? U : never;

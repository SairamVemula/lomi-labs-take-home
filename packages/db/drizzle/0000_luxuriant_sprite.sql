CREATE TYPE "public"."change_status" AS ENUM('new', 'unchanged', 'changed');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('invoice', 'lease', 'market_report');--> statement-breakpoint
CREATE TYPE "public"."review_action" AS ENUM('approved', 'corrected');--> statement-breakpoint
CREATE TYPE "public"."review_origin" AS ENUM('manual', 'carried_over');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'extracting', 'extracted', 'failed', 'superseded');--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"parsed_text" text,
	"active_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_doc_number_uq" UNIQUE("document_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"external_id" text,
	"type" "doc_type" NOT NULL,
	"title" text NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_user_external_uq" UNIQUE("user_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "extracted_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"field_name" text NOT NULL,
	"field_type" text NOT NULL,
	"value" jsonb,
	"evidence" text,
	"evidence_start" integer,
	"evidence_end" integer,
	"gap_reason" text,
	"change_status" "change_status" NOT NULL,
	"previous_value_id" uuid,
	CONSTRAINT "extracted_values_version_field_uq" UNIQUE("version_id","field_name")
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"error" text,
	"error_kind" text,
	"model" text,
	"prompt" jsonb,
	"raw_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "extraction_runs_version_attempt_uq" UNIQUE("version_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"value_id" uuid NOT NULL,
	"action" "review_action" NOT NULL,
	"corrected_value" jsonb,
	"note" text,
	"origin" "review_origin" NOT NULL,
	"carried_from_review_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_hash" text NOT NULL,
	"base_url" text,
	"model" text,
	"encrypted_key" "bytea",
	"is_local" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_identity_hash_unique" UNIQUE("identity_hash")
);
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_active_run_id_extraction_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."extraction_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_id_document_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_run_id_extraction_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."extraction_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_previous_value_fk" FOREIGN KEY ("previous_value_id") REFERENCES "public"."extracted_values"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_value_id_extracted_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."extracted_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_carried_from_fk" FOREIGN KEY ("carried_from_review_id") REFERENCES "public"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
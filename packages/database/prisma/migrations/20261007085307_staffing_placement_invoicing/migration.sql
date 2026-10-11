-- CreateEnum
CREATE TYPE "StaffingInvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'VOID');

-- CreateTable
CREATE TABLE "StaffingPlacement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "candidateJobId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "salary" DECIMAL(12,2) NOT NULL,
    "salaryCurrency" TEXT NOT NULL,
    "feeAmount" DECIMAL(12,2) NOT NULL,
    "feeCurrency" TEXT NOT NULL,
    "feeType" "FeeType" NOT NULL,
    "feeRate" DECIMAL(12,2) NOT NULL,
    "guaranteeUntil" TIMESTAMP(3),
    "guaranteeResolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffingPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffingInvoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "StaffingInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffingInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffingPlacement_candidateJobId_key" ON "StaffingPlacement"("candidateJobId");

-- CreateIndex
CREATE INDEX "StaffingPlacement_organizationId_startDate_idx" ON "StaffingPlacement"("organizationId", "startDate");

-- CreateIndex
CREATE INDEX "StaffingPlacement_clientId_guaranteeUntil_idx" ON "StaffingPlacement"("clientId", "guaranteeUntil");

-- CreateIndex
CREATE UNIQUE INDEX "StaffingInvoice_placementId_key" ON "StaffingInvoice"("placementId");

-- CreateIndex
CREATE INDEX "StaffingInvoice_organizationId_status_createdAt_idx" ON "StaffingInvoice"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StaffingInvoice_organizationId_invoiceNumber_key" ON "StaffingInvoice"("organizationId", "invoiceNumber");

-- AddForeignKey
ALTER TABLE "StaffingPlacement" ADD CONSTRAINT "StaffingPlacement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffingPlacement" ADD CONSTRAINT "StaffingPlacement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffingPlacement" ADD CONSTRAINT "StaffingPlacement_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffingPlacement" ADD CONSTRAINT "StaffingPlacement_candidateJobId_fkey" FOREIGN KEY ("candidateJobId") REFERENCES "CandidateJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffingInvoice" ADD CONSTRAINT "StaffingInvoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffingInvoice" ADD CONSTRAINT "StaffingInvoice_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "StaffingPlacement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

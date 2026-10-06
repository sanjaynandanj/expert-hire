import { hash } from "bcryptjs";
import { prisma } from "../src/client";

if (process.env.NODE_ENV === "production") throw new Error("Fictional demo data must never be seeded into production.");

const demoPassword = await hash("NorthstarDemo!", 12);

async function main() {
  const owner = await prisma.user.upsert({
    where: { email: "owner@acmeworks.test" },
    update: { name: "Avery Rhodes", passwordHash: demoPassword, emailVerifiedAt: new Date() },
    create: { email: "owner@acmeworks.test", name: "Avery Rhodes", passwordHash: demoPassword, emailVerifiedAt: new Date() }
  });
  const recruiter = await prisma.user.upsert({
    where: { email: "recruiter@astersearch.test" },
    update: { name: "Noor Patel", passwordHash: demoPassword, emailVerifiedAt: new Date() },
    create: { email: "recruiter@astersearch.test", name: "Noor Patel", passwordHash: demoPassword, emailVerifiedAt: new Date() }
  });
  const placementOfficer = await prisma.user.upsert({
    where: { email: "placements@riverton.test" },
    update: { name: "Grace Mbatha", passwordHash: demoPassword, emailVerifiedAt: new Date() },
    create: { email: "placements@riverton.test", name: "Grace Mbatha", passwordHash: demoPassword, emailVerifiedAt: new Date() }
  });
  const studentUser = await prisma.user.upsert({
    where: { email: "student@riverton.test" },
    update: { name: "Mira Iyer", passwordHash: demoPassword, emailVerifiedAt: new Date() },
    create: { email: "student@riverton.test", name: "Mira Iyer", passwordHash: demoPassword, emailVerifiedAt: new Date() }
  });
  const studentUser2 = await prisma.user.upsert({
    where: { email: "anaya@riverton.test" },
    update: { name: "Anaya Desai", passwordHash: demoPassword, emailVerifiedAt: new Date() },
    create: { email: "anaya@riverton.test", name: "Anaya Desai", passwordHash: demoPassword, emailVerifiedAt: new Date() }
  });
  const studentUser3 = await prisma.user.upsert({
    where: { email: "kabir@riverton.test" },
    update: { name: "Kabir Menon", passwordHash: demoPassword, emailVerifiedAt: new Date() },
    create: { email: "kabir@riverton.test", name: "Kabir Menon", passwordHash: demoPassword, emailVerifiedAt: new Date() }
  });

  const employer = await prisma.organization.upsert({
    where: { slug: "acme-works" },
    update: {},
    create: { slug: "acme-works", name: "Acme Works", type: "EMPLOYER", creditBalance: 1240, modules: { ats: true, assessments: true, meetings: true } }
  });
  const agency = await prisma.organization.upsert({
    where: { slug: "aster-search" },
    update: {},
    create: { slug: "aster-search", name: "Aster Search", type: "AGENCY", creditBalance: 2200, modules: { ats: true, clients: true, placements: true, productivity: true } }
  });
  const university = await prisma.organization.upsert({
    where: { slug: "riverton-university" },
    update: {},
    create: { slug: "riverton-university", name: "Riverton University", type: "UNIVERSITY", creditBalance: 15_000, modules: { preparation: true, placements: true, proctoring: true } }
  });

  await Promise.all([
    prisma.membership.upsert({ where: { userId_organizationId: { userId: owner.id, organizationId: employer.id } }, update: { role: "OWNER" }, create: { userId: owner.id, organizationId: employer.id, role: "OWNER" } }),
    prisma.membership.upsert({ where: { userId_organizationId: { userId: recruiter.id, organizationId: agency.id } }, update: { role: "OWNER" }, create: { userId: recruiter.id, organizationId: agency.id, role: "OWNER" } }),
    prisma.membership.upsert({ where: { userId_organizationId: { userId: placementOfficer.id, organizationId: university.id } }, update: { role: "OWNER" }, create: { userId: placementOfficer.id, organizationId: university.id, role: "OWNER" } }),
    prisma.membership.upsert({ where: { userId_organizationId: { userId: studentUser.id, organizationId: university.id } }, update: { role: "STUDENT" }, create: { userId: studentUser.id, organizationId: university.id, role: "STUDENT" } }),
    prisma.membership.upsert({ where: { userId_organizationId: { userId: studentUser2.id, organizationId: university.id } }, update: { role: "STUDENT" }, create: { userId: studentUser2.id, organizationId: university.id, role: "STUDENT" } }),
    prisma.membership.upsert({ where: { userId_organizationId: { userId: studentUser3.id, organizationId: university.id } }, update: { role: "STUDENT" }, create: { userId: studentUser3.id, organizationId: university.id, role: "STUDENT" } })
  ]);

  const stageNames = ["New signal", "Human review", "Interview", "Decision"];
  const stages = [];
  for (const [index, name] of stageNames.entries()) {
    stages.push(await prisma.pipelineStage.upsert({
      where: { organizationId_name: { organizationId: employer.id, name } },
      update: { sortOrder: index },
      create: { organizationId: employer.id, name, sortOrder: index, terminal: name === "Decision" }
    }));
  }

  const platformJob = await prisma.job.upsert({
    where: { id: "demo_job_platform_engineer" },
    update: {},
    create: {
      id: "demo_job_platform_engineer",
      organizationId: employer.id,
      title: "Senior Platform Engineer",
      location: "Remote · India",
      description: "Own resilient platform services, guide systems design decisions, improve developer workflows, and help the team operate distributed infrastructure with clear reliability objectives.",
      status: "OPEN",
      workflowEnabled: true,
      requirements: { create: [
        { name: "Distributed systems", weight: 90, sortOrder: 0 },
        { name: "Operational judgment", weight: 80, sortOrder: 1 },
        { name: "Communication", weight: 65, sortOrder: 2 }
      ] },
      rounds: { create: [
        { title: "Resume evidence", type: "RESUME_SCREEN", sequence: 1, durationMinutes: 0, promotionScore: 60 },
        { title: "Systems coding", type: "CODING_TEST", sequence: 2, durationMinutes: 45, promotionScore: 65, proctoringEnabled: true },
        { title: "Adaptive technical", type: "AI_INTERVIEW", sequence: 3, durationMinutes: 25, promotionScore: 70 },
        { title: "Team panel", type: "HUMAN_INTERVIEW", sequence: 4, durationMinutes: 45 }
      ] }
    },
    include: { rounds: true }
  });

  const candidateData = [
    ["Maya Chen", "maya@candidate.test", "Platform engineer", 84, "COMPLETED"],
    ["Jules Park", "jules@candidate.test", "Backend engineer", 77, "IN_PROGRESS"],
    ["Nina Okafor", "nina@candidate.test", "Data engineer", 81, "SHORTLISTED"],
    ["Omar Saleh", "omar@candidate.test", "Solutions architect", 73, "CANCELLED"]
  ] as const;
  for (const [index, [name, email, headline, score, status]] of candidateData.entries()) {
    const stage = stages[Math.min(index, stages.length - 1)];
    if (!stage) throw new Error("Seed pipeline stage is missing");
    const candidate = await prisma.candidate.upsert({
      where: { organizationId_email: { organizationId: employer.id, email } },
      update: {},
      create: { organizationId: employer.id, name, email, headline, source: index % 2 ? "REFERRAL" : "TALENT_POOL", ownerName: "Avery Rhodes" }
    });
    await prisma.candidateJob.upsert({
      where: { candidateId_jobId: { candidateId: candidate.id, jobId: platformJob.id } },
      update: { score, stageId: stage.id },
      create: { candidateId: candidate.id, jobId: platformJob.id, score, stageId: stage.id }
    });
    const round = platformJob.rounds[Math.min(index, platformJob.rounds.length - 1)];
    if (round) {
      await prisma.assessment.upsert({
        where: { id: `demo_assessment_${index + 1}` },
        update: {},
        create: {
          id: `demo_assessment_${index + 1}`,
          candidateId: candidate.id,
          roundId: round.id,
          status,
          score: status === "CANCELLED" || status === "IN_PROGRESS" ? null : score,
          summary: status === "COMPLETED" ? "Strong systems reasoning backed by a clear production example. Human review recommended." : null,
          completedAt: status === "COMPLETED" ? new Date() : null,
          ...(status === "COMPLETED" ? { evidence: { create: [
              { criterion: "Distributed systems", score: 88, weight: 90, rationale: "Explained queue durability and recovery trade-offs.", evidence: "Candidate connected the design to a production incident and described the rollback path." },
              { criterion: "Communication", score: 78, weight: 65, rationale: "Structured and concrete, with one unfinished explanation.", evidence: "Candidate used a clear problem-action-result sequence." }
            ] } } : {}),
          ...(index === 0 ? { integrityEvents: { create: [{ type: "FOCUS_CHANGE", severity: "INFO", detail: { count: 1, advisoryOnly: true } }] } } : {})
        }
      });
    }
  }

  const clientSeeds = [
    ["Aster Labs", "aster-labs", "ACTIVE", "PERCENTAGE", "18", 90],
    ["Kindred Cloud", "kindred-cloud", "BRIEFING", "FLAT", "12000", 60],
    ["Morrow Finance", "morrow-finance", "ACTIVE", "PERCENTAGE", "16", 90]
  ] as const;
  for (const [name, slug, status, feeType, feeAmount, guaranteeDays] of clientSeeds) {
    await prisma.client.upsert({
      where: { organizationId_slug: { organizationId: agency.id, slug } },
      update: {},
      create: { organizationId: agency.id, name, slug, status, feeType, feeAmount, guaranteeDays, ownerName: "Noor Patel", currency: "USD" }
    });
  }

  const campus = await prisma.campus.upsert({
    where: { organizationId_name: { organizationId: university.id, name: "Riverton Main Campus" } },
    update: {},
    create: { organizationId: university.id, name: "Riverton Main Campus", city: "Pune" }
  });
  const batch = await prisma.batch.upsert({
    where: { campusId_name: { campusId: campus.id, name: "2027 Graduating" } },
    update: {},
    create: { campusId: campus.id, name: "2027 Graduating", graduationYear: 2027, branches: ["CSE", "ECE", "Mechanical"] }
  });
  const student = await prisma.studentProfile.upsert({
    where: { userId: studentUser.id },
    update: {},
    create: { userId: studentUser.id, organizationId: university.id, batchId: batch.id, registrationNo: "RVU-CSE-1042", branch: "CSE", cgpa: 8.42, graduationYear: 2027, profileComplete: 92 }
  });
  await prisma.studentProfile.upsert({
    where: { userId: studentUser2.id },
    update: {},
    create: { userId: studentUser2.id, organizationId: university.id, batchId: batch.id, registrationNo: "RVU-CSE-1077", branch: "CSE", cgpa: 8.76, graduationYear: 2027, profileComplete: 88 }
  });
  await prisma.studentProfile.upsert({
    where: { userId: studentUser3.id },
    update: {},
    create: { userId: studentUser3.id, organizationId: university.id, batchId: batch.id, registrationNo: "RVU-MECH-2031", branch: "Mechanical", cgpa: 6.42, graduationYear: 2027, profileComplete: 71 }
  });
  const season = await prisma.placementSeason.upsert({
    where: { organizationId_academicYear: { organizationId: university.id, academicYear: "2026-27" } },
    update: {},
    create: { organizationId: university.id, name: "Placement Season 2026–27", academicYear: "2026-27", offerCap: 1, upgradeMultiple: 1.5 }
  });
  const company = await prisma.placementCompany.upsert({
    where: { organizationId_name: { organizationId: university.id, name: "Northwind Systems" } },
    update: {},
    create: { organizationId: university.id, name: "Northwind Systems", tier: "ENTERPRISE", recruiterName: "Elena Brooks", recruiterEmail: "elena@northwind.test" }
  });
  const drive = await prisma.placementDrive.upsert({
    where: { id: "demo_drive_sde" },
    update: {},
    create: { id: "demo_drive_sde", seasonId: season.id, companyId: company.id, title: "Software Engineer I", description: "Build and operate customer-facing services in a cross-functional product team.", status: "PUBLISHED", jobType: "FULL_TIME", locations: ["Bengaluru", "Remote"], applyBy: new Date("2026-10-30T17:00:00Z"), openings: 12, ctcMin: 1_600_000, ctcMax: 2_200_000, eligibleBranches: ["CSE", "ECE"], minCgpa: 7.0 }
  });
  await prisma.placementDrive.upsert({
    where: { id: "demo_drive_mechanical" },
    update: {},
    create: { id: "demo_drive_mechanical", seasonId: season.id, companyId: company.id, title: "Mechanical Engineering Intern", description: "Support manufacturing process improvement, supplier quality reviews, and plant operations with an experienced engineering team.", status: "PUBLISHED", jobType: "INTERNSHIP", locations: ["Pune"], applyBy: new Date("2026-10-30T17:00:00Z"), openings: 2, ctcMin: 360_000, ctcMax: 480_000, eligibleBranches: ["Mechanical"], minCgpa: 6.0 }
  });
  const application = await prisma.application.upsert({
    where: { driveId_studentId: { driveId: drive.id, studentId: student.id } },
    update: {},
    create: { driveId: drive.id, studentId: student.id, status: "ACCEPTED" }
  });
  await prisma.offer.upsert({
    where: { applicationId: application.id },
    update: {},
    create: { applicationId: application.id, status: "JOINED", ctc: 1_900_000, currency: "INR", joiningDate: new Date("2027-07-06T00:00:00Z") }
  });

  for (const [organization, balance] of [[employer, 1240], [agency, 2200], [university, 15_000]] as const) {
    await prisma.creditLedger.upsert({
      where: { organizationId_idempotencyKey: { organizationId: organization.id, idempotencyKey: "seed-opening-balance" } },
      update: {},
      create: { organizationId: organization.id, amount: balance, balanceAfter: balance, reason: "Demo opening balance", idempotencyKey: "seed-opening-balance" }
    });
  }

  console.log(`Seeded Northstar demo: ${employer.id}, ${agency.id}, ${university.id}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

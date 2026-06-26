import json
import io
import os
import tempfile
import unittest

import server


class FakeHandler:
    def __init__(self):
        self.response = None

    def send_json(self, data, status=200):
        self.response = (status, data)
        return self.response


for name in (
    "_validate_team", "_normalize_loan", "create_team_loan", "update_team_loan",
    "normalize_assignment_dates", "_validate_project_dates",
    "_validate_assignment_eligibility", "_validate_assignment_group",
    "create_assignment_group", "update_assignment_group",
    "create_assignment", "update_assignment",
    "import_csv",
):
    setattr(FakeHandler, name, getattr(server.Handler, name))


class TeamLoanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        server.DATA_DIR = self.tmp.name
        server.DB_PATH = os.path.join(self.tmp.name, "scheduler.sqlite")
        server.INITIAL_DATA_PATH = os.path.join(self.tmp.name, "initial-data.json")
        server.init_db(seed=False)
        t = server.now()
        with server.db() as conn:
            conn.execute("INSERT INTO teams VALUES (?,?,?,?,?,?,?,?)", ("tm_a", "A", "#111111", "", 1, 0, t, t))
            conn.execute("INSERT INTO teams VALUES (?,?,?,?,?,?,?,?)", ("tm_b", "B", "#222222", "", 2, 0, t, t))
            conn.execute("INSERT INTO people(id,name,department,role,daily_capacity,created_at,updated_at,sort_order,archived,color,home_team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         ("p1", "P1", "", "", 8, t, t, 1, 0, "", "tm_a"))
            conn.execute("INSERT INTO projects(id,name,owner,owner_id,priority,color,created_at,updated_at,sort_order,start_date,end_date,archived,team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         ("pr1", "PR1", "", "", "中", "#333333", t, t, 1, "", "", 0, "tm_b"))
        self.handler = FakeHandler()

    def tearDown(self):
        self.tmp.cleanup()

    def test_cross_team_assignment_requires_covering_loan(self):
        self.handler.create_assignment({"personId": "p1", "projectId": "pr1", "date": "2026-06-20", "endDate": "2026-06-21", "hours": 8})
        self.assertEqual(400, self.handler.response[0])

        self.handler.create_team_loan({"personId": "p1", "targetTeamId": "tm_b", "startDate": "2026-06-20", "endDate": "2026-06-30"})
        self.assertEqual(200, self.handler.response[0])
        self.handler.create_assignment({"personId": "p1", "projectId": "pr1", "date": "2026-06-20", "endDate": "2026-06-21", "hours": 8})
        self.assertEqual(200, self.handler.response[0])

    def test_unchanged_historical_assignment_can_still_be_edited(self):
        t = server.now()
        with server.db() as conn:
            conn.execute(
                "INSERT INTO assignments(id,person_id,project_id,work_date,end_date,hours,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                ("a1", "p1", "pr1", "2026-06-20", "2026-06-21", 8, "", t, t)
            )
        self.handler.update_assignment("a1", {"personId": "p1", "projectId": "pr1", "date": "2026-06-20", "endDate": "2026-06-21", "hours": 6, "note": "updated"})
        self.assertEqual(200, self.handler.response[0])
        self.handler.update_assignment("a1", {"personId": "p1", "projectId": "pr1", "date": "2026-06-22", "endDate": "2026-06-23", "hours": 6, "note": "moved"})
        self.assertEqual(400, self.handler.response[0])

    def test_seed_cross_team_assignment_creates_exact_loan(self):
        self.tmp.cleanup()
        self.tmp = tempfile.TemporaryDirectory()
        server.DATA_DIR = self.tmp.name
        server.DB_PATH = os.path.join(self.tmp.name, "scheduler.sqlite")
        server.INITIAL_DATA_PATH = os.path.join(self.tmp.name, "initial-data.json")
        payload = {
            "teams": [{"id": "tm_a", "name": "A"}, {"id": "tm_b", "name": "B"}],
            "people": [{"id": "p1", "name": "P1", "homeTeamId": "tm_a"}],
            "projects": [{"id": "pr1", "name": "PR1", "teamId": "tm_b"}],
            "assignments": [{"id": "a1", "personId": "p1", "projectId": "pr1", "date": "2026-06-20", "endDate": "2026-06-22"}],
        }
        with open(server.INITIAL_DATA_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        server.init_db(seed=True)
        loans = server.rows("SELECT person_id,target_team_id,start_date,end_date FROM person_team_loans")
        self.assertEqual([{"person_id": "p1", "target_team_id": "tm_b", "start_date": "2026-06-20", "end_date": "2026-06-22"}], loans)
        server.init_db(seed=True)
        self.assertEqual(1, server.one("SELECT COUNT(*) AS c FROM person_team_loans")["c"])

    def test_historical_migration_groups_and_takes_min_max_dates(self):
        self.tmp.cleanup()
        self.tmp = tempfile.TemporaryDirectory()
        server.DATA_DIR = self.tmp.name
        server.DB_PATH = os.path.join(self.tmp.name, "scheduler.sqlite")
        server.INITIAL_DATA_PATH = os.path.join(self.tmp.name, "initial-data.json")
        payload = {
            "teams": [{"id": "tm_a", "name": "A"}, {"id": "tm_b", "name": "B"}],
            "people": [{"id": "p1", "name": "P1", "homeTeamId": "tm_a"}],
            "projects": [{"id": "pr1", "name": "PR1", "teamId": "tm_b"}],
            "assignments": [
                {"id": "a1", "personId": "p1", "projectId": "pr1", "date": "2026-06-20", "endDate": "2026-06-22"},
                {"id": "a2", "personId": "p1", "projectId": "pr1", "date": "2026-06-25", "endDate": "2026-06-27"},
            ],
        }
        with open(server.INITIAL_DATA_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        server.init_db(seed=True)
        loans = server.rows("SELECT person_id,target_team_id,start_date,end_date FROM person_team_loans")
        self.assertEqual([{"person_id": "p1", "target_team_id": "tm_b", "start_date": "2026-06-20", "end_date": "2026-06-27"}], loans)

    def test_csv_can_restore_unallocated_loan(self):
        csv_text = (
            "数据类型,日期,结束日期,人员,部门,角色,项目,备注,团队,人员所属团队\n"
            "借调,2026-06-20,2026-06-30,新成员,研发,后端,,支援,团队B,团队A\n"
        )
        with server.db() as conn:
            conn.execute("UPDATE teams SET name='团队A' WHERE id='tm_a'")
            conn.execute("UPDATE teams SET name='团队B' WHERE id='tm_b'")
        raw = csv_text.encode("utf-8")
        self.handler.headers = {"Content-Length": str(len(raw))}
        self.handler.rfile = io.BytesIO(raw)
        self.handler.import_csv()
        self.assertEqual(200, self.handler.response[0])
        self.assertEqual(1, self.handler.response[1]["createdLoans"])
        loan = server.one("SELECT l.start_date,l.end_date,t.name team FROM person_team_loans l JOIN teams t ON t.id=l.target_team_id JOIN people p ON p.id=l.person_id WHERE p.name='新成员'")
        self.assertEqual({"start_date": "2026-06-20", "end_date": "2026-06-30", "team": "团队B"}, dict(loan))

    def test_archived_loan_is_not_eligible_for_assignment(self):
        # 1. 没有借调，创建跨团队排期失败 (400)
        self.handler.create_assignment({"personId": "p1", "projectId": "pr1", "date": "2026-06-20", "endDate": "2026-06-21", "hours": 8})
        self.assertEqual(400, self.handler.response[0])

        # 2. 创建一个已归档的借调关系 (archived=1)
        self.handler.create_team_loan({"personId": "p1", "targetTeamId": "tm_b", "startDate": "2026-06-20", "endDate": "2026-06-30", "archived": 1})
        self.assertEqual(200, self.handler.response[0])
        loan_id = self.handler.response[1]["id"]

        # 3. 虽然有借调关系但已被归档，创建排期仍然失败 (400)
        self.handler.create_assignment({"personId": "p1", "projectId": "pr1", "date": "2026-06-20", "endDate": "2026-06-21", "hours": 8})
        self.assertEqual(400, self.handler.response[0])

        # 4. 更新借调关系，取消归档 (archived=0)
        self.handler.update_team_loan(loan_id, {"personId": "p1", "targetTeamId": "tm_b", "startDate": "2026-06-20", "endDate": "2026-06-30", "archived": 0})
        self.assertEqual(200, self.handler.response[0])

        # 5. 借调关系激活后，创建排期成功 (200)
        self.handler.create_assignment({"personId": "p1", "projectId": "pr1", "date": "2026-06-20", "endDate": "2026-06-21", "hours": 8})
        self.assertEqual(200, self.handler.response[0])

    def test_assignment_group_links_assignments_with_project_boundary(self):
        self.handler.create_team_loan({"personId": "p1", "targetTeamId": "tm_b", "startDate": "2026-06-20", "endDate": "2026-06-30"})
        self.assertEqual(200, self.handler.response[0])
        self.handler.create_assignment_group({"projectId": "pr1", "name": "MSK VGM"})
        self.assertEqual(200, self.handler.response[0])
        group_id = self.handler.response[1]["id"]

        self.handler.create_assignment({
            "personId": "p1", "projectId": "pr1", "groupId": group_id,
            "date": "2026-06-20", "endDate": "2026-06-21", "hours": 8,
        })
        self.assertEqual(200, self.handler.response[0])
        assignment_id = self.handler.response[1]["id"]
        row = server.one("SELECT group_id FROM assignments WHERE id=?", (assignment_id,))
        self.assertEqual({"group_id": group_id}, dict(row))

        self.handler.update_assignment(assignment_id, {"groupId": ""})
        self.assertEqual(200, self.handler.response[0])
        row = server.one("SELECT group_id,work_date,end_date,hours FROM assignments WHERE person_id=? AND project_id=?", ("p1", "pr1"))
        self.assertEqual({"group_id": "", "work_date": "2026-06-20", "end_date": "2026-06-21", "hours": 8.0}, dict(row))

        self.handler.update_assignment(assignment_id, {"groupId": group_id})
        self.assertEqual(200, self.handler.response[0])
        row = server.one("SELECT group_id FROM assignments WHERE person_id=? AND project_id=?", ("p1", "pr1"))
        self.assertEqual({"group_id": group_id}, dict(row))

        t = server.now()
        with server.db() as conn:
            conn.execute("INSERT INTO projects(id,name,owner,owner_id,priority,color,created_at,updated_at,sort_order,start_date,end_date,archived,team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                         ("pr2", "PR2", "", "", "中", "#444444", t, t, 2, "", "", 0, "tm_b"))
        self.handler.create_assignment({
            "personId": "p1", "projectId": "pr2", "groupId": group_id,
            "date": "2026-06-20", "endDate": "2026-06-21", "hours": 8,
        })
        self.assertEqual(400, self.handler.response[0])

    def test_csv_without_requirement_column_preserves_existing_assignment_group(self):
        self.handler.create_team_loan({"personId": "p1", "targetTeamId": "tm_b", "startDate": "2026-06-20", "endDate": "2026-06-30"})
        self.assertEqual(200, self.handler.response[0])
        self.handler.create_assignment_group({"projectId": "pr1", "name": "需求A"})
        self.assertEqual(200, self.handler.response[0])
        group_id = self.handler.response[1]["id"]
        self.handler.create_assignment({
            "personId": "p1", "projectId": "pr1", "groupId": group_id,
            "date": "2026-06-20", "endDate": "2026-06-21", "hours": 8,
            "note": "old",
        })
        self.assertEqual(200, self.handler.response[0])

        csv_text = (
            "数据类型,日期,结束日期,人员,项目,工时/天,备注\n"
            "排期,2026-06-20,2026-06-21,P1,PR1,6,new note\n"
        )
        raw = csv_text.encode("utf-8")
        self.handler.headers = {"Content-Length": str(len(raw))}
        self.handler.rfile = io.BytesIO(raw)
        self.handler.import_csv()
        self.assertEqual(200, self.handler.response[0])
        self.assertEqual(1, self.handler.response[1]["mergedAssignments"])

        row = server.one("SELECT group_id,hours,note FROM assignments WHERE person_id=? AND project_id=?", ("p1", "pr1"))
        self.assertEqual({"group_id": group_id, "hours": 6.0, "note": "new note"}, dict(row))


if __name__ == "__main__":
    unittest.main()
